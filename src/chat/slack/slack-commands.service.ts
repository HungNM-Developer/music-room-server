import { Injectable } from '@nestjs/common';
import { parseYouTubeVideo } from '../../contracts';
import { DjBrainService } from '../../dj/dj-brain.service';
import { isSlackCommand } from '../../dj/dj-rules';
import { ChatNotifierService } from '../chat-notifier.service';
import { type ChatUser, ChatRoomService } from '../chat-room.service';
import { CHAT, chatError } from '../chat-text';
import { SlackApi } from './slack-api.service';
import {
  djSlackOut,
  esc,
  nowMessage,
  queueMessage,
  searchMessage,
} from './slack-blocks';

/**
 * Where a command was typed. `mention`: an @Music Room message — everyone in the channel
 * reads it, so it must never carry the PIN. `threadTs`: the thread to answer in (mentions).
 */
export interface SlackCtx {
  mention: boolean;
  teamId: string;
  channelId: string;
  userId: string;
  userName: string;
  threadTs: string | null;
}

/** An answer: only the author sees it (`ephemeral`) or everyone in the channel / thread. */
export interface SlackOut {
  visibility: 'ephemeral' | 'public';
  text: string;
  blocks?: unknown[];
}

/** `later` (song search) replaces `now` when it is ready. */
export interface SlackAnswer {
  now: SlackOut;
  later?: Promise<SlackOut>;
}

const ephemeral = (text: string, blocks?: unknown[]): SlackAnswer => ({
  now: { visibility: 'ephemeral', text, ...(blocks ? { blocks } : {}) },
});
/**
 * "/music <câu>" is seen by the asker only: the DJ's answer to the channel says who asked
 * what. (A mention's answer sits in the thread under the question.)
 */
function withQuestion(out: SlackOut, userId: string, q: string): SlackOut {
  const head = `<@${userId}> hỏi DJ: “${esc(q)}”`;
  return {
    ...out,
    text: `${head}\n${out.text}`,
    ...(out.blocks
      ? {
          blocks: [
            { type: 'context', elements: [{ type: 'mrkdwn', text: head }] },
            ...out.blocks,
          ],
        }
      : {}),
  };
}

const pub = (text: string, blocks?: unknown[]): SlackAnswer => ({
  now: { visibility: 'public', text, ...(blocks ? { blocks } : {}) },
});

/**
 * The words after "/music" or "@Music Room": the same commands from both places. The
 * slash command and the Events API only differ in how the answer is delivered.
 */
@Injectable()
export class SlackCommands {
  constructor(
    private readonly slack: SlackApi,
    private readonly chat: ChatRoomService,
    private readonly notifier: ChatNotifierService,
    private readonly brain: DjBrainService,
  ) {}

  private user(ctx: SlackCtx): Promise<ChatUser> {
    // Slash commands also carry the handle; mentions carry no name at all.
    return this.slack.chatUser(ctx.teamId, ctx.userId, ctx.userName);
  }

  async run(ctx: SlackCtx, text: string): Promise<SlackAnswer> {
    const [word = '', ...rest] = text.trim().split(/\s+/);
    const sub = word.toLowerCase();
    const arg = rest.join(' ').trim();
    try {
      if (sub === 'help') return ephemeral(CHAT.help);
      // A mention is a normal, public message: a PIN typed there is visible to everyone.
      if (ctx.mention && (sub === 'connect' || sub === 'disconnect'))
        return ephemeral(CHAT.pinInMention);
      if (sub === 'connect') {
        const [code, pin] = rest;
        if (!code || !pin) return ephemeral(CHAT.connectUsage);
        const room = await this.chat.connect(
          'slack',
          ctx.teamId,
          ctx.channelId,
          code,
          pin,
        );
        const link = await this.chat.link('slack', ctx.teamId, ctx.channelId);
        if (link) this.notifier.forget(link.roomId);
        return pub(CHAT.connected(room.name, room.code));
      }
      if (sub === 'disconnect') {
        if (!rest[0]) return ephemeral(CHAT.disconnectUsage);
        const link = await this.chat.link('slack', ctx.teamId, ctx.channelId);
        await this.chat.disconnect('slack', ctx.teamId, ctx.channelId, rest[0]);
        if (link) this.notifier.forget(link.roomId);
        return pub(CHAT.disconnected);
      }

      const link = await this.chat.link('slack', ctx.teamId, ctx.channelId);
      if (!link) return ephemeral(CHAT.notLinked);
      const roomId = link.roomId;

      // Votes go to this thread (@Music Room here in a thread) or back to the channel (/music here).
      if (sub === 'here') {
        await this.chat.setThread(
          'slack',
          ctx.teamId,
          ctx.channelId,
          ctx.threadTs,
        );
        this.notifier.forget(roomId);
        return pub(ctx.threadTs ? CHAT.hereThread : CHAT.hereChannel);
      }

      // A natural sentence, even one starting with a command word ("skip giúp tôi bài này"),
      // goes to the DJ; the old commands only in their short form (spec 2026-10-18-dj-chat).
      if (!isSlackCommand(text)) {
        const user = await this.user(ctx);
        const later = this.chat
          .asMember(roomId, user)
          .then(async ({ actor }) => {
            const reply = await this.brain.handle({
              actor,
              request: text.trim(),
              platform: 'slack',
            });
            const view = await this.chat.now(roomId);
            const out = djSlackOut(reply, view?.roomUrl ?? null);
            return ctx.mention
              ? out
              : withQuestion(out, ctx.userId, text.trim());
          })
          .catch(
            (e: unknown): SlackOut => ({
              visibility: 'ephemeral',
              text: chatError(e),
            }),
          );
        return {
          now: { visibility: 'ephemeral', text: CHAT.askingDj },
          later,
        };
      }

      switch (sub) {
        case '':
        case 'now': {
          const view = await this.chat.now(roomId);
          if (!view) return ephemeral(CHAT.notLinked);
          const m = nowMessage(view);
          return pub(m.text, m.blocks);
        }
        case 'queue': {
          const view = await this.chat.now(roomId);
          return ephemeral(view ? queueMessage(view) : CHAT.queueEmpty);
        }
        case 'skip': {
          await this.chat.vote(roomId, await this.user(ctx), true);
          return ephemeral(CHAT.voted(true));
        }
        case 'add': {
          if (!arg) return ephemeral(CHAT.addUsage);
          const user = await this.user(ctx);
          if (parseYouTubeVideo(arg)) {
            const r = await this.chat.add(roomId, user, arg);
            return ephemeral(CHAT.added(r.title));
          }
          // Searching can take a moment: answer now, results follow.
          const later = this.chat.find(roomId, user, arg).then(
            (results): SlackOut => ({
              visibility: 'ephemeral',
              ...searchMessage(arg, results),
            }),
            (e: unknown): SlackOut => ({
              visibility: 'ephemeral',
              text: chatError(e),
            }),
          );
          return {
            now: { visibility: 'ephemeral', text: CHAT.searching(arg) },
            later,
          };
        }
        default:
          return ephemeral(CHAT.help);
      }
    } catch (e) {
      return ephemeral(chatError(e));
    }
  }
}
