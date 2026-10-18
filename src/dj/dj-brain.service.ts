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
import { type Plan, planCombo, type Target } from './dj-plan';
import {
  extractDjRequest,
  howTopic,
  isHowQuestion,
  matchQuick,
  matchRules,
  type QuickMatch,
} from './dj-rules';
import {
  CHAT_REPLY_MAX,
  parseTranslation,
  TRANSLATE_SYSTEM,
  translateInput,
} from './dj-translate';

const AI_TIMEOUT_MS = 12_000;
const HOUR_MS = 3600_000;
/** Names sent to the AI so it can tell "của Lan" (a member) from "của J97" (an artist). */
const MEMBERS_FOR_AI = 40;

type Base = Pick<DjReply, 'forMemberId' | 'forName'>;

/** One queue song named by title or place, nothing wider ("bài Lạc Trôi", "bài số 2"). */
function oneSong(t: Target): boolean {
  if (t.all || t.others || t.by || t.artist || t.keep || t.except?.length)
    return false;
  return (
    t.titles?.length === 1 ||
    t.positions?.length === 1 ||
    t.first === 1 ||
    t.last === 1
  );
}

/**
 * A single task that is one button of the "Hướng dẫn" sheet (skip one song, pause, save the song
 * on air, heart / remove / pin one song): the DJ shows the button instead of pressing it (user's
 * choice, 2026-10-18). Several tasks, songs to find, or many songs at once are still done.
 */
function guideOfSingle(plan: Plan): GuideTarget | null {
  if (plan.wish || plan.steps.length !== 1) return null;
  const s = plan.steps[0];
  switch (s.do) {
    case 'skip':
      return (s.count ?? 1) === 1 ? 'skip' : null;
    case 'pause':
    case 'resume':
      return 'pause';
    case 'save':
      return s.target ? null : 'save';
    case 'heart':
      return oneSong(s.target) ? 'heart' : null;
    case 'remove':
      return oneSong(s.target) ? 'itemMenu' : null;
    case 'pin':
      // "Phát ngay bài X" is two buttons (pin, then skip): the DJ does it.
      return !s.now && oneSong(s.target) ? 'itemMenu' : null;
    default:
      return null;
  }
}

/** The help topic a task belongs to, for "làm sao để <task>" read by the AI as the task. */
function guideOfPlan(plan: Plan): GuideTarget | null {
  const s = plan.steps[0];
  if (!s) return null;
  switch (s.do) {
    case 'skip':
      return 'skip';
    case 'pause':
    case 'resume':
      return 'pause';
    case 'heart':
      return 'heart';
    case 'remove':
    case 'pin':
    case 'replace':
    case 'replaceWith':
      return 'itemMenu';
    case 'save':
      return s.target ? 'playlist' : 'save';
    case 'playlistSave':
    case 'playlistCreate':
    case 'playlistPlay':
      return 'playlist';
    case 'find':
      return s.suggest ? 'suggestions' : 'add';
    default:
      return 'add';
  }
}

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

  handle(input: { actor: Actor; request: string }): Promise<DjReply> {
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
  }: {
    actor: Actor;
    request: string;
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
      const quick = matchQuick(request);
      if (quick) return await this.fromQuick(quick, me, actor, base);
      if (!this.ai.enabled)
        return await this.withoutAi(request, me, actor, base);
      // Only requests that need the AI count against the free quota.
      const key = `dj-ai:${me.id}`;
      const r = this.limiter.hit(
        key,
        this.env.DJ_AI_PER_HOUR,
        HOUR_MS,
        Date.now(),
      );
      if (!r.ok)
        return await this.withoutAi(request, me, actor, base, r.retryAfterSec);
      const raw = await this.ai.json<unknown>(
        'dj',
        TRANSLATE_SYSTEM,
        translateInput(
          me.displayName,
          await this.memberNames(me.roomId),
          request,
        ),
        { temperature: 0.2, timeoutMs: AI_TIMEOUT_MS },
      );
      if (raw === null) {
        // Every provider resting: the asker's free quota is not spent.
        this.limiter.undo(key);
        return await this.withoutAi(request, me, actor, base, 0);
      }
      const t = parseTranslation(raw);
      // "Làm sao để …": show where it is, never do it (the AI read it as a task).
      if (isHowQuestion(request)) {
        const guide =
          t.kind === 'guide'
            ? t.guide
            : t.kind === 'plan'
              ? guideOfPlan(t.plan)
              : null;
        if (guide) return await this.guide(guide, me, base);
        if (t.kind === 'info') return await this.info(t.info, me, base);
        return { ...base, kind: 'other' };
      }
      switch (t.kind) {
        case 'plan':
          return await this.combo(t.plan, me, actor, base);
        case 'info':
          return await this.info(t.info, me, base);
        case 'guide':
          return await this.guide(t.guide, me, base);
        case 'clarify':
          return { ...base, kind: 'clarify', clarify: { about: t.about } };
        case 'chat':
          return this.chat(t.reply, request, me.roomId, base);
      }
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

  /** Who is in the room (people, not speakers), for "của <member>" vs "của <artist>". */
  private async memberNames(roomId: string): Promise<string[]> {
    const rows = await this.prisma.member.findMany({
      where: { roomId, leftAt: null, kickedAt: null, isDevice: false },
      select: { displayName: true },
      orderBy: { lastSeenAt: 'desc' },
      take: MEMBERS_FOR_AI,
    });
    return rows.map((r) => r.displayName);
  }

  private async fromQuick(
    q: QuickMatch,
    me: Member,
    actor: Actor,
    base: Base,
  ): Promise<DjReply> {
    switch (q.kind) {
      case 'hello':
        return { ...base, kind: 'hello' };
      case 'info':
        return this.info(q.info, me, base);
      case 'guide':
        return this.guide(q.guide, me, base);
      case 'plan':
        return this.combo(q.plan, me, actor, base);
    }
  }

  /**
   * No AI (off, quota spent or every provider resting): the old combo rules may add, suggest
   * or answer, but never remove (spec: removing is never a guess). `retryAfterSec`: the
   * asker's quota is spent (> 0) or the providers rest (0).
   */
  private async withoutAi(
    request: string,
    me: Member,
    actor: Actor,
    base: Base,
    retryAfterSec?: number,
  ): Promise<DjReply> {
    // A how-to question with no known topic: nothing to do without the AI either.
    if (isHowQuestion(request)) {
      const topic = howTopic(request);
      if (topic) return this.guide(topic, me, base);
      return retryAfterSec !== undefined
        ? {
            ...base,
            kind: 'busy',
            ...(retryAfterSec > 0 ? { retryAfterSec } : {}),
          }
        : { ...base, kind: 'other' };
    }
    const plan = planCombo(request);
    const safe = plan?.steps.filter(
      (s) => s.do !== 'remove' && s.do !== 'replace',
    );
    if (plan && safe?.length && safe.length === plan.steps.length)
      return this.combo({ ...plan, steps: safe }, me, actor, base);
    const rule = matchRules(request);
    if (rule?.kind === 'info') return this.info(rule.info, me, base);
    // "bài mới của Đen": a real YouTube lookup, no AI needed.
    if (rule?.kind === 'fresh')
      return this.combo(
        {
          steps: [
            {
              do: 'find',
              find: { artist: rule.artist, mode: rule.mode },
              count: 1,
            },
          ],
        },
        me,
        actor,
        base,
      );
    if (rule?.kind === 'guide' && rule.guide !== 'add')
      return this.guide(rule.guide, me, base);
    if (retryAfterSec !== undefined)
      return {
        ...base,
        kind: 'busy',
        ...(retryAfterSec > 0 ? { retryAfterSec } : {}),
      };
    return { ...base, kind: 'other' };
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
    const single = guideOfSingle(plan);
    if (single) return this.guide(single, me, base);
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
    }
    return { ...base, kind: 'info', info };
  }
}
