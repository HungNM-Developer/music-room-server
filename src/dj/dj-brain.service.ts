import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { DjService } from '../ai/dj.service';
import { AppError } from '../common/app-error';
import { RateLimiter } from '../common/rate-limiter';
import { ENV, type Env } from '../config/env';
import {
  type DjInfo,
  type DjReply,
  type ErrorCode,
  GUIDE_TARGETS,
  type GuideTarget,
  INFO_KINDS,
  type InfoKind,
} from '../contracts';
import type { Member } from '../generated/prisma/client';
import { InnerTubeProvider } from '../music/innertube.provider';
import { SearchService } from '../music/search.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { SocialService } from '../social/social.service';
import type { Actor } from '../state/room-state.service';
import { SnapshotService } from '../state/snapshot.service';
import { DjComboService } from './dj-combo.service';
import { etaSec } from './dj-eta';
import { findFresh } from './dj-fresh';
import { guideOfAiPlan, type Plan, planCombo, planFromAi } from './dj-plan';
import { extractDjRequest, matchRules, type RuleMatch } from './dj-rules';

const AI_TIMEOUT_MS = 12_000;
const HOUR_MS = 3600_000;
/** Songs one request may try before giving up (blocked, queued, just played…). */
const MAX_TRIES = 5;
const MAX_PICKS = 5;

/** The song cannot go in, but the next candidate might. */
const TRY_NEXT: ErrorCode[] = [
  'ALREADY_QUEUED',
  'TRACK_BLOCKED',
  'TRACK_TOO_LONG',
  'PLAYED_RECENTLY',
  'TRACK_NOT_EMBEDDABLE',
  'TRACK_NOT_FOUND',
  'TRACK_LIVE',
];

const SYSTEM = `Bạn là DJ của một phòng nghe nhạc chung ở văn phòng Việt Nam. Phân loại yêu cầu và trả JSON.
"intent":
- "add": người dùng muốn nghe / thêm nhạc nhưng chưa nói rõ tên bài (tâm trạng, thể loại, giống bài đang phát, của một nghệ sĩ...).
  - Nếu họ muốn bài MỚI / mới nhất / vừa ra / đang hot / trending của MỘT nghệ sĩ: đặt "fresh": {"artist": <tên nghệ sĩ>, "mode": "latest" | "popular"} và KHÔNG đoán tên bài.
  - Ngược lại đặt "items": tối đa 5 bài CÓ THẬT [{"artist","song"}], đúng nghệ sĩ gốc, ưu tiên bài trong "known" (ghi đúng như danh sách), không bịa, hợp nghe chung ở văn phòng. Yêu cầu không nói rõ thì ưu tiên nhạc Việt và nhạc quốc tế phổ biến.
- "guide": họ hỏi cách làm một việc trên trang. "guide" là một trong: ${GUIDE_TARGETS.join(', ')}.
- "info": họ hỏi về tình trạng phòng. "info" là một trong: ${INFO_KINDS.join(', ')}.
- "do": họ nhờ DJ làm việc với hàng chờ / máy phát: nhiều việc một lúc, thả tim, xoá, ghim, chuyển tới một bài, bỏ qua, tạm dừng, phát tiếp, thêm nhiều bài... Đặt "steps" theo đúng thứ tự họ nói, mỗi bước là một trong:
  {"do":"add","titles":["<tên bài họ nêu>"],"pin"?:"next"|"now"}
  {"do":"addArtist","artist":"<nghệ sĩ>","count":1-5,"mode":"top"|"latest"|"popular"}
  {"do":"addPicks","items":[{"artist","song"}],"pin"?:"next"|"now"}  (họ chỉ nói chung chung: bạn chọn bài CÓ THẬT, như "items" ở trên)
  {"do":"addFrom","source":"played"|"saved","count":1-5}  (bài vừa phát / bài họ đã lưu)
  {"do":"heart"|"remove"|"pin"|"skipTo","target":{...}}  (pin = phát tiếp theo; skipTo = chuyển tới bài đó ngay)
  {"do":"skip","count"?:n}, {"do":"pause"}, {"do":"resume"}
  "target" chọn bài trong "queue": {"all"?:true,"mine"?:true (bài của người hỏi),"others"?:true (bài của người khác),"by"?:"<tên người chọn>","titles"?:[...],"except"?:[tên bài giữ lại],"positions"?:[số thứ tự trong "queue", 1 = bài kế tiếp, -1 = bài cuối],"first"?:n,"last"?:n}
  Muốn nghe một bài trong hàng chờ NGAY / liền / luôn / bây giờ: "skipTo"; chỉ muốn nó phát tiếp theo (ghim, ưu tiên): "pin".
  Họ xin hơn 5 bài: vẫn ghi đúng số họ xin trong "count". Có lời chúc / tặng ai: đặt "wish" (chuỗi ngắn).
- "other": việc khác.
Trả lời đúng JSON: {"intent": ..., "guide"?: ..., "info"?: ..., "fresh"?: {...}, "items"?: [...], "steps"?: [...], "wish"?: ...}.`;

interface AiAnswer {
  intent?: string;
  guide?: string;
  info?: string;
  fresh?: { artist?: string; mode?: string };
  items?: { artist?: string; song?: string }[];
  /** intent "do": the AI planner's steps (checked by planFromAi). */
  steps?: unknown;
  wish?: unknown;
}

/** Queue songs the AI may point at ("bài số 2", "bài của Lan"). */
const QUEUE_FOR_AI = 30;

/**
 * The "@DJ" assistant (spec 2026-10-18-dj-chat), shared by the room chat and Slack: the rules
 * first (no AI), then at most one AI call; anything it does goes through the web's services
 * as the asker. Never throws: every outcome is a `DjReply`.
 */
@Injectable()
export class DjBrainService {
  private readonly logger = new Logger(DjBrainService.name);
  readonly limiter = new RateLimiter();
  /** One request at a time per member (two quick "@DJ" must not add the same song twice). */
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly dj: DjService,
    private readonly queue: QueueService,
    private readonly snapshots: SnapshotService,
    private readonly search: SearchService,
    private readonly innertube: InnerTubeProvider,
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
    const base = {
      forMemberId: actor.memberId,
      forName: me?.displayName ?? '',
    };
    if (!me || me.roomId !== actor.roomId || me.leftAt || me.kickedAt)
      return { ...base, kind: 'error', errorCode: 'UNAUTHENTICATED' };
    try {
      // Several tasks at once: the DJ does them itself (a single one stays a guide).
      const plan = planCombo(request);
      if (plan) return await this.combo(plan, me, actor, base);
      const rule = matchRules(request);
      if (rule) return await this.fromRule(rule, me, actor, base);
      if (!this.ai.enabled) return { ...base, kind: 'other' };
      // Only requests that need the AI count against the free quota.
      const r = this.limiter.hit(
        `dj-ai:${me.id}`,
        this.env.DJ_AI_PER_HOUR,
        HOUR_MS,
        Date.now(),
      );
      if (!r.ok)
        return { ...base, kind: 'busy', retryAfterSec: r.retryAfterSec };
      const answer = await this.callAi(request, actor.roomId);
      if (!answer) {
        // Every provider resting: the asker's free quota is not spent.
        this.limiter.undo(`dj-ai:${me.id}`);
        return { ...base, kind: 'busy' };
      }
      return await this.fromAi(answer, me, actor, base);
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

  /** The one AI call of a request (not counted here: callers hit the quota). */
  private async callAi(
    request: string,
    roomId: string,
  ): Promise<AiAnswer | null> {
    const snap = await this.snapshots.build(roomId);
    const np = snap?.nowPlaying?.item.track;
    return this.ai.json<AiAnswer>(
      'dj',
      SYSTEM,
      JSON.stringify({
        request,
        nowPlaying: np
          ? np.artist && np.song
            ? `${np.artist} - ${np.song}`
            : np.title
          : null,
        known: await this.dj.knownTitles(roomId),
        queue: (snap?.queue ?? []).slice(0, QUEUE_FOR_AI).map((q, i) => ({
          position: i + 1,
          title: q.track.title,
          addedBy: q.addedBy?.displayName ?? null,
        })),
      }),
      { temperature: 0.2, timeoutMs: AI_TIMEOUT_MS },
    );
  }

  /** Several tasks: carried out in order; one add alone keeps the "added" answer. */
  private async combo(
    plan: Plan,
    me: Member,
    actor: Actor,
    base: Pick<DjReply, 'forMemberId' | 'forName'>,
  ): Promise<DjReply> {
    const steps = await this.combos.run(plan, me, actor, (text, count) =>
      this.aiPicks(text, count, me, actor),
    );
    const only = steps.length === 1 ? steps[0] : null;
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
      if (only.reason === 'notFound')
        return { ...base, kind: 'error', errorCode: 'TRACK_NOT_FOUND' };
      return {
        ...base,
        kind:
          only.errorCode === 'QUEUE_LIMIT' || only.errorCode === 'FORBIDDEN'
            ? 'denied'
            : 'error',
        ...(only.errorCode ? { errorCode: only.errorCode } : {}),
        ...(only.errorParams ? { errorParams: only.errorParams } : {}),
      };
    }
    return { ...base, kind: 'done', steps };
  }

  /** Songs for a vague part of a combo ("2 bài chill"): one AI call, on the asker's quota. */
  private async aiPicks(
    text: string,
    count: number,
    me: Member,
    actor: Actor,
  ): Promise<{ artist: string; song: string }[] | null> {
    if (!this.ai.enabled) return null;
    const key = `dj-ai:${me.id}`;
    if (!this.limiter.hit(key, this.env.DJ_AI_PER_HOUR, HOUR_MS, Date.now()).ok)
      return null;
    const answer = await this.callAi(`${text} (${count} bài)`, actor.roomId);
    if (!answer) {
      this.limiter.undo(key);
      return null;
    }
    return picksOf(answer);
  }

  private async fromRule(
    rule: RuleMatch,
    me: Member,
    actor: Actor,
    base: Pick<DjReply, 'forMemberId' | 'forName'>,
  ): Promise<DjReply> {
    switch (rule.kind) {
      case 'hello':
        return { ...base, kind: 'hello' };
      case 'guide':
        return this.guide(rule.guide, me, base, rule.query);
      case 'info':
        return this.info(rule.info, me, base);
      case 'fresh':
        return this.addFresh(rule.artist, rule.mode, me, actor, base);
    }
  }

  private async fromAi(
    a: AiAnswer,
    me: Member,
    actor: Actor,
    base: Pick<DjReply, 'forMemberId' | 'forName'>,
  ): Promise<DjReply> {
    if (
      a.intent === 'guide' &&
      (GUIDE_TARGETS as readonly string[]).includes(a.guide ?? '')
    )
      return this.guide(a.guide as GuideTarget, me, base);
    if (
      a.intent === 'info' &&
      (INFO_KINDS as readonly string[]).includes(a.info ?? '')
    )
      return this.info(a.info as InfoKind, me, base);
    if (a.intent === 'do') {
      const plan = planFromAi(a.steps, a.wish);
      if (plan) {
        // One simple task stays a guide (the asker can do it with one button), like the rules.
        const guide = guideOfAiPlan(plan);
        if (guide) return this.guide(guide, me, base);
        return this.combo(plan, me, actor, base);
      }
    }
    if (a.intent === 'add' || a.intent === 'do') {
      const artist = a.fresh?.artist?.trim();
      if (artist)
        return this.addFresh(
          artist.slice(0, 100),
          a.fresh?.mode === 'popular' ? 'popular' : 'latest',
          me,
          actor,
          base,
        );
      const picks = picksOf(a);
      if (picks.length) return this.addPicks(picks, me, actor, base);
    }
    return { ...base, kind: 'other' };
  }

  private async guide(
    target: GuideTarget,
    me: Member,
    base: Pick<DjReply, 'forMemberId' | 'forName'>,
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

  private async info(
    kind: InfoKind,
    me: Member,
    base: Pick<DjReply, 'forMemberId' | 'forName'>,
  ): Promise<DjReply> {
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

  private async addFresh(
    artist: string,
    mode: 'latest' | 'popular',
    me: Member,
    actor: Actor,
    base: Pick<DjReply, 'forMemberId' | 'forName'>,
  ): Promise<DjReply> {
    const { videos, verified } = await findFresh(
      { innertube: this.innertube, search: this.search },
      me.id,
      artist,
      mode,
    );
    return this.addFirst(
      videos.map((v) => v.externalId),
      actor,
      base,
      verified ? mode : null,
    );
  }

  private async addPicks(
    picks: { artist: string; song: string }[],
    me: Member,
    actor: Actor,
    base: Pick<DjReply, 'forMemberId' | 'forName'>,
  ): Promise<DjReply> {
    // Lazily: the next pick is looked up only when the previous one could not go in.
    const ids = (async function* (self: DjBrainService) {
      for (const p of picks) {
        const known = await self.dj.findKnown(p.artist, p.song);
        if (known) {
          yield known.externalId;
          continue;
        }
        const { results } = await self.search.search(
          me.id,
          `${p.artist} ${p.song}`,
        );
        if (results[0]) yield results[0].externalId;
      }
    })(this);
    return this.addFirst(ids, actor, base, null);
  }

  /** Adds the first candidate the room accepts, as the asker. */
  private async addFirst(
    ids: Iterable<string> | AsyncIterable<string>,
    actor: Actor,
    base: Pick<DjReply, 'forMemberId' | 'forName'>,
    fresh: 'latest' | 'popular' | null,
  ): Promise<DjReply> {
    let tries = 0;
    for await (const id of ids) {
      // Each try is one of the asker's adds per minute (ADD_LIMIT): a few, not the whole list.
      if (++tries > MAX_TRIES) break;
      try {
        const { queueItemId } = await this.queue.add(actor, {
          input: `https://www.youtube.com/watch?v=${id}`,
        });
        const snap = await this.snapshots.build(actor.roomId);
        // An idle room plays the song at once: it is on air, not in the queue.
        if (snap?.nowPlaying?.item.id === queueItemId)
          return {
            ...base,
            kind: 'added',
            queueItemId,
            track: snap.nowPlaying.item.track,
            position: 0,
            etaSec: 0,
            fresh,
          };
        const at = snap?.queue.findIndex((q) => q.id === queueItemId) ?? -1;
        const item = at >= 0 ? snap!.queue[at] : null;
        return {
          ...base,
          kind: 'added',
          queueItemId,
          ...(item ? { track: item.track } : {}),
          position: at >= 0 ? at + 1 : undefined,
          etaSec: snap && at >= 0 ? etaSec(snap, at) : null,
          fresh,
        };
      } catch (e) {
        if (e instanceof AppError && TRY_NEXT.includes(e.code)) continue;
        if (e instanceof AppError)
          return {
            ...base,
            kind:
              e.code === 'FORBIDDEN' || e.code === 'QUEUE_LIMIT'
                ? 'denied'
                : 'error',
            errorCode: e.code,
            ...(e.params ? { errorParams: e.params } : {}),
          };
        throw e;
      }
    }
    return { ...base, kind: 'error', errorCode: 'TRACK_NOT_FOUND' };
  }
}

/** The AI's song picks, checked and kept short (names go into a search). */
function picksOf(a: AiAnswer): { artist: string; song: string }[] {
  // Asked for songs, the AI may still answer with a plan: its chosen songs are in "addPicks".
  const fromSteps = Array.isArray(a.steps)
    ? (a.steps as { do?: unknown; items?: AiAnswer['items'] }[])
        .filter((s) => s?.do === 'addPicks' && Array.isArray(s.items))
        .flatMap((s) => s.items ?? [])
    : [];
  return (a.items?.length ? a.items : fromSteps)
    .filter(
      (p): p is { artist: string; song: string } =>
        typeof p.artist === 'string' &&
        typeof p.song === 'string' &&
        p.artist.trim() !== '' &&
        p.song.trim() !== '',
    )
    .slice(0, MAX_PICKS)
    .map((p) => ({
      artist: p.artist.trim().slice(0, 100),
      song: p.song.trim().slice(0, 150),
    }));
}
