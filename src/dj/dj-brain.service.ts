import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { blockedWords } from '../ai/moderation';
import { AppError } from '../common/app-error';
import { RateLimiter } from '../common/rate-limiter';
import { ENV, type Env } from '../config/env';
import {
  type DjInfo,
  type DjReply,
  type DjStep,
  type GuideTarget,
  type InfoKind,
} from '../contracts';
import type { Member } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SocialService } from '../social/social.service';
import type { Actor } from '../state/room-state.service';
import { SnapshotService } from '../state/snapshot.service';
import { DjComboService } from './dj-combo.service';
import { etaSec } from './dj-eta';
import { chatLine } from './dj-chat-lines';
import {
  type AiCall,
  type Decision,
  interpret,
  type Platform,
  QUEUE_FOR_AI,
  type RoomContext,
} from './dj-interpret';
import type { Plan } from './dj-plan';
import { extractDjRequest } from './dj-rules';
import { CHAT_REPLY_MAX } from './dj-translate';

const AI_TIMEOUT_MS = 12_000;
const HOUR_MS = 3600_000;
/** Names sent to the AI so it can tell "của Lan" (a member) from "của J97" (an artist). */
const MEMBERS_FOR_AI = 40;

type Base = Pick<DjReply, 'forMemberId' | 'forName'>;
/** Accents of Vietnamese: the asker wrote in Vietnamese (for the DJ's own lines). */
const VIETNAMESE =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

/**
 * The "@DJ" assistant (specs 2026-10-18-dj-chat and 2026-10-18-dj-translator), shared by the
 * room chat and Slack: short certain requests by rule; everything else is translated by one AI
 * call into steps the server carries out as the asker. Never throws: every outcome is a `DjReply`.
 */
@Injectable()
export class DjBrainService {
  private readonly logger = new Logger(DjBrainService.name);
  readonly limiter = new RateLimiter();
  /** One request at a time per member (two quick "@DJ" must not add the same song twice). */
  private readonly running = new Map<string, Promise<unknown>>();
  /** The DJ's own small-talk line used last in each room (not twice in a row). */
  private readonly lastLine = new Map<string, number>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly snapshots: SnapshotService,
    private readonly social: SocialService,
    private readonly combos: DjComboService,
  ) {}

  /** After a room chat message is saved: answer it when it is addressed to "@DJ". */
  onRoomChat(actor: Actor, content: string): void {
    const request = extractDjRequest(content);
    if (request === null) return;
    void this.handle({ actor, request })
      .then((reply) =>
        // The asker left or was removed meanwhile: the answer is dropped (spec).
        reply.errorCode === 'UNAUTHENTICATED'
          ? undefined
          : this.social.postDj(actor.roomId, reply),
      )
      .catch((e: unknown) =>
        this.logger.error(
          `DJ answer failed: ${e instanceof Error ? e.stack : String(e)}`,
        ),
      );
  }

  /**
   * `platform`: where the request was made. Slack has no spotlight, so a one-button task is
   * done there; the room page shows the button instead.
   */
  handle(input: {
    actor: Actor;
    request: string;
    platform?: Platform;
  }): Promise<DjReply> {
    const key = input.actor.memberId;
    const before = this.running.get(key) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(() => this.answer(input));
    this.running.set(key, next);
    void next.finally(() => {
      if (this.running.get(key) === next) this.running.delete(key);
    });
    return next;
  }

  private async answer({
    actor,
    request,
    platform = 'room',
  }: {
    actor: Actor;
    request: string;
    platform?: Platform;
  }): Promise<DjReply> {
    const me = await this.prisma.member.findUnique({
      where: { id: actor.memberId },
    });
    const base: Base = {
      forMemberId: actor.memberId,
      forName: me?.displayName ?? '',
    };
    if (!me || me.roomId !== actor.roomId || me.leftAt || me.kickedAt)
      return { ...base, kind: 'error', errorCode: 'UNAUTHENTICATED' };
    try {
      const decision = await interpret({
        request,
        room: await this.roomContext(me),
        platform,
        ai: this.ai.enabled ? this.aiCall(me.id) : null,
      });
      return await this.carryOut(decision, request, me, actor, base);
    } catch (e) {
      if (e instanceof AppError)
        return {
          ...base,
          kind: 'error',
          errorCode: e.code,
          ...(e.params ? { errorParams: e.params } : {}),
        };
      this.logger.error(
        `DJ failed: ${e instanceof Error ? e.stack : String(e)}`,
      );
      return { ...base, kind: 'error', errorCode: 'INTERNAL' };
    }
  }

  /** The room as the AI sees it (spec: resolve "bài này", "bài của Lan", "bài số 3"). */
  private async roomContext(me: Member): Promise<RoomContext> {
    const [snap, rows] = await Promise.all([
      this.snapshots.build(me.roomId),
      this.prisma.member.findMany({
        where: {
          roomId: me.roomId,
          leftAt: null,
          kickedAt: null,
          isDevice: false,
        },
        select: { displayName: true },
        orderBy: { lastSeenAt: 'desc' },
        take: MEMBERS_FOR_AI,
      }),
    ]);
    const song = (
      t: { title: string; artist: string | null },
      by?: string | null,
    ) => ({
      title: t.title,
      artist: t.artist,
      by: by ?? null,
    });
    const np = snap?.nowPlaying;
    return {
      asker: me.displayName,
      members: rows.map((r) => r.displayName),
      nowPlaying: np ? song(np.item.track, np.item.addedBy?.displayName) : null,
      queue: (snap?.queue ?? [])
        .slice(0, QUEUE_FOR_AI)
        .map((q) => song(q.track, q.addedBy?.displayName)),
    };
  }

  /** The request's one AI call, on the asker's free quota (given back when no AI answers). */
  private aiCall(memberId: string): AiCall {
    return async (system, user) => {
      const key = `dj-ai:${memberId}`;
      const r = this.limiter.hit(
        key,
        this.env.DJ_AI_PER_HOUR,
        HOUR_MS,
        Date.now(),
      );
      if (!r.ok) return { ok: false, retryAfterSec: r.retryAfterSec };
      const raw = await this.ai.json<unknown>('dj', system, user, {
        temperature: 0.2,
        timeoutMs: AI_TIMEOUT_MS,
      });
      if (raw === null) {
        // Every provider resting: the asker's free quota is not spent.
        this.limiter.undo(key);
        return { ok: false, retryAfterSec: 0 };
      }
      return { ok: true, raw };
    };
  }

  private async carryOut(
    d: Decision,
    request: string,
    me: Member,
    actor: Actor,
    base: Base,
  ): Promise<DjReply> {
    switch (d.kind) {
      case 'hello':
      case 'other':
        return { ...base, kind: d.kind };
      case 'busy':
        return {
          ...base,
          kind: 'busy',
          ...(d.retryAfterSec ? { retryAfterSec: d.retryAfterSec } : {}),
        };
      case 'info':
        return this.info(d.info, me, base);
      case 'guide':
        return this.guide(d.guide, me, base);
      case 'clarify':
        return { ...base, kind: 'clarify', clarify: { about: d.about } };
      case 'chat':
        return this.chat(d.reply, request, me.roomId, base);
      case 'plan':
        return this.combo(d.plan, me, actor, base);
    }
  }

  /** Small talk: the AI's line when it is short and clean, else one of the DJ's own. */
  private chat(
    reply: string | null,
    request: string,
    roomId: string,
    base: Base,
  ): DjReply {
    const line = reply?.trim();
    if (line && line.length <= CHAT_REPLY_MAX && !blockedWords(line).length)
      return { ...base, kind: 'chat', chatReply: line };
    const lang =
      VIETNAMESE.test(request) || !/[a-z]/i.test(request) ? 'vi' : 'en';
    const { text, index } = chatLine(lang, this.lastLine.get(roomId));
    this.lastLine.set(roomId, index);
    return { ...base, kind: 'chat', chatReply: text };
  }

  /** The steps, carried out in order; one plain add alone keeps the "added" answer. */
  private async combo(
    plan: Plan,
    me: Member,
    actor: Actor,
    base: Base,
  ): Promise<DjReply> {
    // No second AI call: vague parts of the old rules ("2 bài chill") wait for the translator.
    const steps = await this.combos.run(plan, me, actor, () =>
      Promise.resolve(null),
    );
    // Several of the asker's playlists fit the name: ask which one.
    const which = steps.find(
      (s) => s.reason === 'noPlaylist' && s.options?.length,
    );
    if (which)
      return {
        ...base,
        kind: 'clarify',
        clarify: { about: 'whichPlaylist', options: which.options },
      };
    const only: DjStep | null = steps.length === 1 ? steps[0] : null;
    if (only?.action === 'add' && !only.wish) {
      if (only.ok)
        return {
          ...base,
          kind: 'added',
          queueItemId: only.queueItemId,
          ...(only.track ? { track: only.track } : {}),
          position: only.position,
          etaSec: only.etaSec ?? null,
          fresh: only.fresh ?? null,
        };
      if (only.reason === 'busy') return { ...base, kind: 'busy' };
      if (only.reason === 'notFound' && only.got === undefined)
        return { ...base, kind: 'done', steps };
      if (only.errorCode === 'QUEUE_LIMIT' || only.errorCode === 'FORBIDDEN')
        return {
          ...base,
          kind: 'denied',
          errorCode: only.errorCode,
          ...(only.errorParams ? { errorParams: only.errorParams } : {}),
        };
    }
    return { ...base, kind: 'done', steps };
  }

  private async guide(
    target: GuideTarget,
    me: Member,
    base: Base,
    query?: string,
  ): Promise<DjReply> {
    if (target === 'block' && me.role !== 'ADMIN')
      return { ...base, kind: 'denied', guide: target, errorCode: 'FORBIDDEN' };
    if (target === 'myItem') {
      const snap = await this.snapshots.build(me.roomId);
      const mine = snap?.queue.find((q) => q.addedBy?.id === me.id);
      if (!mine) return this.info('myNext', me, base);
      return { ...base, kind: 'guide', guide: target, queueItemId: mine.id };
    }
    return {
      ...base,
      kind: 'guide',
      guide: target,
      ...(query ? { query: query.slice(0, 150) } : {}),
    };
  }

  private async info(kind: InfoKind, me: Member, base: Base): Promise<DjReply> {
    const snap = await this.snapshots.build(me.roomId);
    const np = snap?.nowPlaying ?? null;
    const queue = snap?.queue ?? [];
    let info: DjInfo;
    switch (kind) {
      case 'nowPlaying':
      case 'whoPicked':
        info = {
          kind,
          title: np?.item.track.title ?? null,
          pickedBy: np?.item.addedBy?.displayName ?? null,
        };
        break;
      case 'myNext': {
        const at = queue.findIndex((q) => q.addedBy?.id === me.id);
        info =
          at < 0
            ? { kind }
            : {
                kind,
                ahead: at,
                etaSec: snap ? etaSec(snap, at) : null,
                queueItemId: queue[at].id,
              };
        break;
      }
      case 'queueLength':
        info = {
          kind,
          count: queue.length,
          totalSec: queue.every((q) => q.track.durationSec)
            ? queue.reduce((s, q) => s + (q.track.durationSec ?? 0), 0)
            : null,
        };
        break;
      case 'myCount':
        info = {
          kind,
          count: queue.filter((q) => q.addedBy?.id === me.id).length,
        };
        break;
      case 'nextSong':
        info = queue[0]
          ? {
              kind,
              title: queue[0].track.title,
              pickedBy: queue[0].addedBy?.displayName ?? null,
              etaSec: snap ? etaSec(snap, 0) : null,
            }
          : { kind, title: null };
        break;
    }
    return { ...base, kind: 'info', info };
  }
}
