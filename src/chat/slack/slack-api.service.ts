import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import type { ChatUser } from '../chat-room.service';

export interface SlackProfile {
  /** '' when Slack did not tell us (users.info failed or the user has no name). */
  name: string;
  email: string | null;
  /** The profile picture (72 px: avatars are at most 36 px, ×2 for sharp screens); null when Slack gave none. */
  image: string | null;
}

const PROFILE_TTL_MS = 60 * 60_000;
const TIMEOUT_MS = 5000;

/** The few Slack Web API calls the bot needs, with the workspace's bot token. */
@Injectable()
export class SlackApi {
  private readonly logger = new Logger(SlackApi.name);
  private readonly profiles = new Map<
    string,
    { at: number; p: SlackProfile }
  >();
  /** Overridable in probes. */
  fetchImpl = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => fetch(input, init);

  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return Boolean(this.env.SLACK_BOT_TOKEN && this.env.SLACK_SIGNING_SECRET);
  }

  get signingSecret(): string {
    return this.env.SLACK_SIGNING_SECRET ?? '';
  }

  /**
   * `form`: read methods such as users.info ignore JSON bodies and only take form-encoded
   * arguments; posting methods accept JSON (needed for blocks).
   */
  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    form = false,
  ): Promise<T | null> {
    try {
      const res = await this.fetchImpl(
        `${this.env.SLACK_API_URL.replace(/\/$/, '')}/${method}`,
        {
          method: 'POST',
          headers: {
            'content-type': form
              ? 'application/x-www-form-urlencoded'
              : 'application/json; charset=utf-8',
            authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
          },
          body: form
            ? new URLSearchParams(
                Object.entries(body).map(([k, v]) => [k, String(v)]),
              ).toString()
            : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      const json = (await res.json()) as { ok: boolean; error?: string } & T;
      if (!json.ok) {
        this.logger.warn(`slack ${method} failed: ${json.error ?? res.status}`);
        return null;
      }
      return json;
    } catch (e) {
      this.logger.warn(`slack ${method} failed: ${String(e)}`);
      return null;
    }
  }

  /** Returns the message timestamp (its id for updates), or null. */
  async post(
    channel: string,
    text: string,
    blocks: unknown[],
    threadTs?: string | null,
  ): Promise<string | null> {
    const r = await this.call<{ ts: string }>('chat.postMessage', {
      channel,
      text,
      blocks,
      unfurl_links: false,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return r?.ts ?? null;
  }

  /** Only `user` sees it (in the thread when `threadTs` is given). */
  async postEphemeral(
    channel: string,
    user: string,
    text: string,
    blocks: unknown[] = [],
    threadTs?: string | null,
  ): Promise<void> {
    await this.call('chat.postEphemeral', {
      channel,
      user,
      text,
      ...(blocks.length ? { blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  async update(
    channel: string,
    ts: string,
    text: string,
    blocks: unknown[],
  ): Promise<void> {
    await this.call('chat.update', { channel, ts, text, blocks });
  }

  /** Home tab: what `user` sees when they open the app (replaces their previous Home). */
  async publishView(
    user: string,
    view: Record<string, unknown>,
  ): Promise<boolean> {
    return Boolean(await this.call('views.publish', { user_id: user, view }));
  }

  /** Opens a modal; `triggerId` comes with the click and is valid for 3 seconds. */
  async openView(
    triggerId: string,
    view: Record<string, unknown>,
  ): Promise<string | null> {
    const r = await this.call<{ view: { id: string } }>('views.open', {
      trigger_id: triggerId,
      view,
    });
    return r?.view.id ?? null;
  }

  async updateView(
    viewId: string,
    view: Record<string, unknown>,
  ): Promise<void> {
    await this.call('views.update', { view_id: viewId, view });
  }

  /** The person behind a Slack user id, as chat actions need them. */
  async chatUser(
    teamId: string,
    userId: string,
    fallbackName = '',
  ): Promise<ChatUser> {
    const p = await this.profile(userId);
    return {
      platform: 'slack',
      teamId,
      userId,
      name: p.name || fallbackName,
      profileName: p.name,
      email: p.email,
      avatarUrl: p.image,
    };
  }

  /** Display name, email and picture (needs users:read and users:read.email), cached for an hour. */
  async profile(userId: string): Promise<SlackProfile> {
    const hit = this.profiles.get(userId);
    if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.p;
    const r = await this.call<{
      user: {
        name?: string;
        real_name?: string;
        profile?: {
          display_name?: string;
          real_name?: string;
          email?: string;
          image_192?: string;
          image_72?: string;
          image_48?: string;
        };
      };
    }>('users.info', { user: userId }, true);
    const u = r?.user;
    const p: SlackProfile = {
      name:
        u?.profile?.display_name ||
        u?.profile?.real_name ||
        u?.real_name ||
        u?.name ||
        '',
      email: u?.profile?.email ?? null,
      image:
        u?.profile?.image_72 ||
        u?.profile?.image_48 ||
        u?.profile?.image_192 ||
        null,
    };
    if (r && p.name) this.profiles.set(userId, { at: Date.now(), p });
    else
      this.logger.warn(
        `slack users.info gave no name for ${userId} (needs users:read; reinstall the app after changing scopes)`,
      );
    return p;
  }

  /** Replies through a slash command's / button's response_url (ephemeral by default). */
  async respond(
    responseUrl: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.fetchImpl(responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ response_type: 'ephemeral', ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      this.logger.warn(`slack response_url failed: ${String(e)}`);
    }
  }
}
