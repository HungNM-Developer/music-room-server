import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { AppError } from '../common/app-error';
import { TIMING, type Timing } from '../common/timing';
import {
  type CommandInput,
  type PlayerCommand,
  parseYouTubePlaylist,
  type PlayerRevokeReason,
  SKIP_MIN_YES,
  type Voice,
} from '../contracts';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { orderQueue } from '../queue/fair-queue';
import { Broadcaster } from '../realtime/broadcaster.service';
import { ActivityService } from '../social/activity.service';
import {
  type Actor,
  type MutateCtx,
  RoomStateService,
} from '../state/room-state.service';
import { readSettings } from '../state/settings';
import { SnapshotService } from '../state/snapshot.service';
import { estimatePosition } from '../state/views';
import { McService } from '../ai/mc.service';
import { TtsService } from '../tts/tts.service';
import { voiceOf } from '../tts/tts-lang';
import { SuggestService } from '../music/suggest.service';
import { TrackCacheService } from '../music/track-cache.service';
import { pickFallback } from './fallback';
import { LeaseService } from './lease.service';
import { countVotes, requiredVotes } from './skip-votes';

export type AdvanceReason = 'ended' | 'timer' | 'skip' | 'error' | 'start';

/** Drift (s) between the player's report and our estimate that triggers a re-broadcast. */
const DRIFT_SEC = 2;
/**
 * How often the watchdog looks for songs past their end. The end-of-song timer lives in one
 * process's memory: a deploy (two instances for a moment), a restart or a failed advance can
 * lose it, and a room without a player device would then sit on a finished song for ever.
 */
const WATCHDOG_EVERY_MS = 30_000;
/** YouTube's "not found / private" (100) and "not playable in an embed / here" (101, 150). */
const UNPLAYABLE_CODES: readonly number[] = [100, 101, 150];
const FALLBACK_RECENT = 20;
/** Re-making waiting wishes' Edge audio (lost on restart): how often per room, how many. */
const WARM_EVERY_MS = 60_000;
const WARM_MAX = 6;

/** V1: after a vote keeps a song, no new vote on it for this long. */
export const SKIP_BLOCK_MS = 2 * 60_000;

@Injectable()
export class PlaybackService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PlaybackService.name);
  private watchdog: NodeJS.Timeout | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly warmedAt = new Map<string, number>();
  /** `roomId item` whose line is being made right now: re-sent once, when the audio is ready. */
  private readonly awaitingSpeech = new Set<string>();
  /** V1: one open skip vote per room at most; fires at its deadline. */
  private readonly voteTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: RoomStateService,
    private readonly lease: LeaseService,
    private readonly broadcaster: Broadcaster,
    private readonly activity: ActivityService,
    private readonly snapshots: SnapshotService,
    @Inject(TIMING) private readonly timing: Timing,
    private readonly suggest: SuggestService,
    private readonly mc: McService,
    private readonly tts: TtsService,
    private readonly tracks: TrackCacheService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.lease.onChange = (roomId) => void this.state.touch(roomId);
    this.state.onDeleted((roomId) => {
      const t = this.timers.get(roomId);
      if (t) clearTimeout(t);
      this.timers.delete(roomId);
      this.clearVoteTimer(roomId);
    });
    await this.restore();
    this.watchdog = setInterval(
      () => void this.sweepOverdue(),
      WATCHDOG_EVERY_MS,
    );
    this.watchdog.unref();
  }

  onModuleDestroy(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const t of this.voteTimers.values()) clearTimeout(t);
    this.voteTimers.clear();
  }

  // ------------------------------------------------------------ transitions

  /**
   * Ends the current item (if any) and starts the next one (R-24). Must run inside
   * RoomStateService.mutate. Throws STALE_ITEM when `expected` is not current.
   */
  async advance(
    tx: Tx,
    ctx: MutateCtx,
    roomId: string,
    expected: string | null,
    reason: AdvanceReason,
  ): Promise<string | null> {
    const ps = await tx.playbackState.findUniqueOrThrow({ where: { roomId } });
    if (ps.currentItemId !== expected) throw new AppError('STALE_ITEM');
    if (ps.currentItemId) {
      await tx.queueItem.update({
        where: { id: ps.currentItemId },
        data: {
          status:
            reason === 'ended' || reason === 'timer' ? 'PLAYED' : 'SKIPPED',
          endedAt: ctx.now,
        },
      });
    }
    return this.startNext(tx, ctx, roomId);
  }

  private async startNext(
    tx: Tx,
    ctx: MutateCtx,
    roomId: string,
  ): Promise<string | null> {
    const room = await tx.room.findUniqueOrThrow({
      where: { id: roomId },
      select: { settings: true },
    });
    const settings = readSettings(room.settings);
    const queued = await tx.queueItem.findMany({
      where: { roomId, status: 'QUEUED' },
      include: { hearts: { select: { memberId: true } } },
    });
    const ordered = orderQueue(
      queued.map((q) => ({
        id: q.id,
        addedAt: q.addedAt.getTime(),
        pinnedAt: q.pinnedAt?.getTime() ?? null,
        hearts: q.hearts.length,
      })),
    );
    // Members' songs first; an empty queue goes to the radio (A4), then the fallback playlist.
    const nextId =
      ordered[0]?.id ??
      (settings.autoRadio
        ? await this.createRadioItem(tx, roomId, settings, ctx.now)
        : null) ??
      (await this.createFallbackItem(tx, roomId, settings));

    if (nextId) {
      const item = await tx.queueItem.update({
        where: { id: nextId },
        data: { status: 'PLAYING', startedAt: ctx.now, pinnedAt: null },
      });
      if (item.addedById) {
        // R-33: lastPlayedAt moves when the member's track *starts*.
        await tx.member.update({
          where: { id: item.addedById },
          data: { lastPlayedAt: ctx.now },
        });
      }
      // Have the radio's Last.fm picks ready for when this song ends (outside the transaction).
      // Not awaited: afterCommit runs under the room lock, and Last.fm / AI can take seconds.
      ctx.afterCommit(() => {
        void this.suggest
          .warmFor(item.trackId)
          .then(() =>
            settings.autoRadio
              ? this.suggest.planRadio(roomId, settings)
              : undefined,
          );
      });
      await tx.playbackState.update({
        where: { roomId },
        data: {
          currentItemId: nextId,
          status: 'PLAYING',
          positionSec: 0,
          positionAt: ctx.now,
        },
      });
    } else {
      await tx.playbackState.update({
        where: { roomId },
        data: {
          currentItemId: null,
          status: 'IDLE',
          positionSec: 0,
          positionAt: ctx.now,
        },
      });
    }
    ctx.afterCommit(() => this.afterChange(roomId));
    return nextId;
  }

  /** A4: a known song like the last one (no YouTube quota), not repeated within 3 hours. */
  private async createRadioItem(
    tx: Tx,
    roomId: string,
    settings: ReturnType<typeof readSettings>,
    now: Date,
  ): Promise<string | null> {
    const pick = await this.suggest.radioPick(tx, roomId, settings, now);
    if (!pick) return null;
    const item = await tx.queueItem.create({
      data: {
        roomId,
        trackId: pick,
        addedById: null,
        auto: 'radio',
        status: 'QUEUED',
      },
    });
    return item.id;
  }

  /**
   * R-31: random fallback track, avoiding the last 20 automatic picks and anything played
   * within the room's repeat gap (A6) — avoided, not refused: a short playlist still plays.
   */
  private async createFallbackItem(
    tx: Tx,
    roomId: string,
    settings: ReturnType<typeof readSettings>,
  ): Promise<string | null> {
    const parsed = settings.fallbackPlaylistUrl
      ? parseYouTubePlaylist(settings.fallbackPlaylistUrl)
      : null;
    if (!parsed) return null;
    const cache = await tx.playlistCache.findUnique({
      where: { playlistId: parsed.playlistId },
    });
    if (!cache || cache.videoIds.length === 0) {
      this.logger.warn(`Room ${roomId}: fallback playlist not cached or empty`);
      return null;
    }
    const tracks = await tx.track.findMany({
      where: {
        id: { in: cache.videoIds.map((v) => `youtube:${v}`) },
        embeddable: true,
        // Blocked by the admin: never picked by the fallback playlist either.
        blockedTracks: { none: { roomId } },
      },
      select: { id: true, durationSec: true },
    });
    const max = settings.maxTrackDurationSec;
    const eligible = tracks
      .filter(
        (t) => max === 0 || t.durationSec === null || t.durationSec <= max,
      )
      .map((t) => t.id);
    const recent = await tx.queueItem.findMany({
      where: { roomId, addedById: null },
      orderBy: { addedAt: 'desc' },
      take: FALLBACK_RECENT,
      select: { trackId: true },
    });
    const gap = settings.repeatGapMinutes;
    const played = gap
      ? await tx.queueItem.findMany({
          where: {
            roomId,
            startedAt: { gte: new Date(Date.now() - gap * 60_000) },
          },
          select: { trackId: true },
        })
      : [];
    const pick = pickFallback(eligible, [
      ...recent.map((r) => r.trackId),
      ...played.map((p) => p.trackId),
    ]);
    if (!pick) return null;
    const item = await tx.queueItem.create({
      data: {
        roomId,
        trackId: pick,
        addedById: null,
        auto: 'fallback',
        status: 'QUEUED',
      },
    });
    return item.id;
  }

  /** Starts playback when the room is idle (R-19). Safe to call after any queue change. */
  async startIfIdle(tx: Tx, ctx: MutateCtx, roomId: string): Promise<void> {
    const ps = await tx.playbackState.findUniqueOrThrow({ where: { roomId } });
    if (ps.status === 'IDLE' && ps.currentItemId === null) {
      await this.startNext(tx, ctx, roomId);
    }
  }

  /**
   * R-25 / V1: advances as soon as enough *online* voters say ✅ (the threshold). When the
   * window runs out, silence is not a "no": it advances if ✅ outnumber ❌ with at least
   * SKIP_MIN_YES ✅, else keeps the song. It also keeps the song early once ✅ can win
   * neither way. Call after votes, presence or settings change, and at the deadline.
   */
  async reevaluateSkip(tx: Tx, ctx: MutateCtx, roomId: string): Promise<void> {
    const ps = await tx.playbackState.findUniqueOrThrow({ where: { roomId } });
    if (!ps.currentItemId || ps.status === 'IDLE') return;
    const room = await tx.room.findUniqueOrThrow({
      where: { id: roomId },
      select: {
        settings: true,
        members: {
          where: { leftAt: null, kickedAt: null },
          select: { id: true, isDevice: true },
        },
      },
    });
    const item = await tx.queueItem.findUniqueOrThrow({
      where: { id: ps.currentItemId },
      include: {
        track: { select: { title: true } },
        skipVotes: { select: { memberId: true, approve: true } },
      },
    });
    const voters = this.snapshots.onlineVoters(roomId, room.members);
    const tally = (approve: boolean) =>
      countVotes(
        item.skipVotes
          .filter((v) => v.approve === approve)
          .map((v) => v.memberId),
        voters,
      ).votes;
    const yes = tally(true);
    const no = tally(false);
    const settings = readSettings(room.settings);
    const minVotes = settings.skipMinVotes;
    const required = requiredVotes(
      voters.size,
      settings.skipThreshold,
      minVotes,
    );
    if (yes > 0 && yes >= required) {
      await this.advance(tx, ctx, roomId, ps.currentItemId, 'skip');
      await this.activity.log(
        tx,
        ctx,
        roomId,
        null,
        'track_skip',
        `"${item.track.title}" đã bị bỏ qua sau ${yes} phiếu`,
        { variant: 'votes', title: item.track.title, yes },
      );
      return;
    }
    // Votes from before V1 have no window: they simply wait for the threshold.
    if (!item.skipVoteEndsAt) return;
    const undecided = Math.max(0, voters.size - yes - no);
    const expired = item.skipVoteEndsAt.getTime() <= ctx.now.getTime();
    // Time's up: more ✅ than ❌ skips, never below the room's minimum.
    if (expired && yes > no && yes >= Math.max(SKIP_MIN_YES, minVotes)) {
      await this.advance(tx, ctx, roomId, ps.currentItemId, 'skip');
      await this.activity.log(
        tx,
        ctx,
        roomId,
        null,
        'track_skip',
        `"${item.track.title}" đã bị bỏ qua khi hết giờ (✅ ${yes} · ❌ ${no})`,
        { variant: 'timeout', title: item.track.title, yes, no },
      );
      return;
    }
    // Best case for ✅: every online voter who has not voted yet says ✅.
    const best = yes + undecided;
    const canWin = best >= required || (best > no && best >= SKIP_MIN_YES);
    // With a minimum set, people who are not online (Slack) may still vote: wait for the end.
    if (!expired && yes > 0 && (canWin || minVotes > 1)) return;
    await tx.skipVote.deleteMany({ where: { queueItemId: item.id } });
    await tx.queueItem.update({
      where: { id: item.id },
      data: {
        skipVoteEndsAt: null,
        skipVoteById: null,
        skipBlockedUntil: new Date(ctx.now.getTime() + SKIP_BLOCK_MS),
      },
    });
    await this.activity.log(
      tx,
      ctx,
      roomId,
      null,
      'skip_kept',
      `Cả phòng chọn nghe tiếp "${item.track.title}" (✅ ${yes} · ❌ ${no})`,
      { title: item.track.title, yes, no },
    );
    ctx.afterCommit(() => this.clearVoteTimer(roomId));
  }

  // ------------------------------------------------------------ commands

  /**
   * V1: the first ✅ opens a vote for `skipVoteWindowSec`; later ✅ / ❌ (changeable) count
   * while it is open. A song kept by a vote cannot be put to a vote again for a while.
   */
  async voteSkip(
    actor: Actor,
    queueItemId: string,
    approve = true,
  ): Promise<void> {
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.state.activeMember(tx, actor);
      if (me.isDevice) throw new AppError('FORBIDDEN');
      const ps = await tx.playbackState.findUniqueOrThrow({
        where: { roomId: actor.roomId },
      });
      if (ps.currentItemId !== queueItemId || ps.status === 'IDLE') {
        throw new AppError('STALE_ITEM');
      }
      let item = await tx.queueItem.findUniqueOrThrow({
        where: { id: queueItemId },
      });
      const now = ctx.now.getTime();
      // A window that ran out but whose timer has not fired yet is settled first.
      if (item.skipVoteEndsAt && item.skipVoteEndsAt.getTime() <= now) {
        await this.reevaluateSkip(tx, ctx, actor.roomId);
        const after = await tx.playbackState.findUniqueOrThrow({
          where: { roomId: actor.roomId },
        });
        if (after.currentItemId !== queueItemId) return;
        item = await tx.queueItem.findUniqueOrThrow({
          where: { id: queueItemId },
        });
      }
      if (!item.skipVoteEndsAt) {
        if (!approve) throw new AppError('VOTE_CLOSED');
        const blocked = item.skipBlockedUntil?.getTime() ?? 0;
        if (blocked > now) {
          throw new AppError('SKIP_BLOCKED', {
            seconds: Math.ceil((blocked - now) / 1000),
          });
        }
        const room = await tx.room.findUniqueOrThrow({
          where: { id: actor.roomId },
          select: { settings: true },
        });
        const endsAt = new Date(
          now + readSettings(room.settings).skipVoteWindowSec * 1000,
        );
        await tx.queueItem.update({
          where: { id: queueItemId },
          data: { skipVoteEndsAt: endsAt, skipVoteById: me.id },
        });
        ctx.afterCommit(() =>
          this.armVoteTimer(actor.roomId, queueItemId, endsAt.getTime()),
        );
      }
      await tx.skipVote.upsert({
        where: { queueItemId_memberId: { queueItemId, memberId: me.id } },
        create: { queueItemId, memberId: me.id, approve },
        update: { approve },
      });
      await this.reevaluateSkip(tx, ctx, actor.roomId);
    });
  }

  async control(
    actor: Actor,
    input: CommandInput<'playback:control'>,
  ): Promise<void> {
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.state.activeMember(tx, actor);
      const ps = await tx.playbackState.findUniqueOrThrow({
        where: { roomId: actor.roomId },
      });
      // The speaker itself may pause / resume: someone at it paused the YouTube video.
      const atSpeaker =
        ps.playerMemberId === me.id &&
        (input.action === 'pause' || input.action === 'play');
      if (me.role !== 'ADMIN' && !me.canControl && !atSpeaker)
        throw new AppError('FORBIDDEN');
      if (ps.currentItemId !== input.queueItemId || ps.status === 'IDLE') {
        throw new AppError('STALE_ITEM');
      }
      const item = await tx.queueItem.findUniqueOrThrow({
        where: { id: input.queueItemId },
        include: { track: true },
      });
      const now = ctx.now;
      switch (input.action) {
        case 'pause':
          if (ps.status === 'PLAYING') {
            await tx.playbackState.update({
              where: { roomId: actor.roomId },
              data: {
                status: 'PAUSED',
                positionSec: estimatePosition(ps, now.getTime()),
                positionAt: now,
              },
            });
          }
          break;
        case 'play':
          if (ps.status === 'PAUSED') {
            await tx.playbackState.update({
              where: { roomId: actor.roomId },
              data: { status: 'PLAYING', positionAt: now },
            });
          }
          break;
        case 'seek': {
          const pos = input.positionSec;
          const dur = item.track.durationSec;
          if (pos === undefined || (dur !== null && pos > dur)) {
            throw new AppError('VALIDATION');
          }
          await tx.playbackState.update({
            where: { roomId: actor.roomId },
            data: { positionSec: pos, positionAt: now },
          });
          break;
        }
        case 'skip':
          await this.advance(tx, ctx, actor.roomId, input.queueItemId, 'skip');
          await this.activity.log(
            tx,
            ctx,
            actor.roomId,
            me,
            'track_skip',
            `đã bỏ qua "${item.track.title}"`,
            { variant: 'by', title: item.track.title },
          );
          return;
      }
      ctx.afterCommit(() => this.afterChange(actor.roomId));
    });
  }

  /** R-27/R-14: a device or canPlay member takes the player lease. */
  async claimPlayer(actor: Actor): Promise<void> {
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.state.activeMember(tx, actor);
      if (!me.isDevice && !me.canPlay) throw new AppError('FORBIDDEN');
      await tx.member.updateMany({
        where: { roomId: actor.roomId, id: { not: me.id }, canPlay: true },
        data: { canPlay: false },
      });
      if (!me.canPlay) {
        await tx.member.update({
          where: { id: me.id },
          data: { canPlay: true },
        });
      }
      await tx.playbackState.update({
        where: { roomId: actor.roomId },
        data: { playerMemberId: me.id },
      });
      const previous = this.lease.holder(actor.roomId);
      if (previous?.memberId !== me.id) {
        await this.activity.log(
          tx,
          ctx,
          actor.roomId,
          me,
          'player_change',
          'đã trở thành máy phát',
        );
      }
      ctx.afterCommit(async () => {
        const replaced = this.lease.claim(actor.roomId, me.id, actor.socketId);
        if (replaced) {
          this.broadcaster.toSocket(replaced.socketId, 'player:revoked', {
            reason: 'replaced',
          });
        }
        await this.sendPlayerCommand(actor.roomId);
      });
    });
  }

  /** Drops the lease held by `memberId` and tells its socket why. */
  releasePlayer(
    roomId: string,
    memberId: string,
    reason: PlayerRevokeReason,
  ): void {
    const dropped = this.lease.release(roomId, memberId);
    if (dropped)
      this.broadcaster.toSocket(dropped.socketId, 'player:revoked', { reason });
  }

  /**
   * Renews the lease for the holder's socket. If the lease *expired* (laptop slept,
   * throttled background tab) and this member is still the room's player, it is
   * granted again instead of leaving the speaker silent (review P1-2).
   */
  private async ensureLease(actor: Actor): Promise<void> {
    if (this.lease.renew(actor.roomId, actor.socketId)) return;
    if (this.lease.holder(actor.roomId)) throw new AppError('FORBIDDEN');
    const ps = await this.prisma.playbackState.findUnique({
      where: { roomId: actor.roomId },
    });
    const me = await this.prisma.member.findUnique({
      where: { id: actor.memberId },
    });
    const stillPlayer =
      ps?.playerMemberId === actor.memberId &&
      me &&
      !me.leftAt &&
      !me.kickedAt &&
      me.canPlay;
    if (!stillPlayer) throw new AppError('FORBIDDEN');
    this.lease.claim(actor.roomId, actor.memberId, actor.socketId);
    await this.sendPlayerCommand(actor.roomId);
  }

  /** R-27: keeps the lease while idle. */
  async heartbeat(actor: Actor): Promise<void> {
    await this.ensureLease(actor);
  }

  /** R-28: only the lease holder may report, and only about the current item. */
  async report(
    actor: Actor,
    input: CommandInput<'player:report'>,
  ): Promise<void> {
    await this.ensureLease(actor);

    if (input.event === 'ended' || input.event === 'error') {
      await this.state.mutate(actor.roomId, async (tx, ctx) => {
        const item = await tx.queueItem.findUnique({
          where: { id: input.queueItemId },
          include: { track: { select: { title: true, externalId: true } } },
        });
        await this.advance(
          tx,
          ctx,
          actor.roomId,
          input.queueItemId,
          input.event === 'ended' ? 'ended' : 'error',
        );
        if (input.event === 'error' && item) {
          await this.activity.log(
            tx,
            ctx,
            actor.roomId,
            null,
            'track_error',
            `Bỏ qua "${item.track.title}" vì video không phát được (mã ${input.errorCode ?? '?'})`,
            { title: item.track.title, code: input.errorCode },
          );
          // Gone / not playable here: never picked again (radio, suggestions).
          if (UNPLAYABLE_CODES.includes(input.errorCode ?? 0))
            ctx.afterCommit(
              () => void this.tracks.markUnplayable(item.track.externalId),
            );
        }
      });
      return;
    }

    // started / progress: keep the stored position honest (R-32).
    const ps = await this.prisma.playbackState.findUnique({
      where: { roomId: actor.roomId },
    });
    if (!ps || ps.currentItemId !== input.queueItemId)
      throw new AppError('STALE_ITEM');
    if (ps.status !== 'PLAYING' || input.positionSec === undefined) return;
    const now = new Date();
    const drift = Math.abs(
      estimatePosition(ps, now.getTime()) - input.positionSec,
    );
    if (drift > DRIFT_SEC) {
      await this.state.mutate(actor.roomId, async (tx, ctx) => {
        await tx.playbackState.updateMany({
          where: {
            roomId: actor.roomId,
            currentItemId: input.queueItemId,
            status: 'PLAYING',
          },
          data: { positionSec: input.positionSec, positionAt: ctx.now },
        });
        ctx.afterCommit(() => this.scheduleTimer(actor.roomId));
      });
    } else {
      await this.prisma.playbackState.updateMany({
        where: {
          roomId: actor.roomId,
          currentItemId: input.queueItemId,
          status: 'PLAYING',
        },
        data: { positionSec: input.positionSec, positionAt: now },
      });
    }
  }

  /**
   * A listener's own player (listen-along) says the song on air cannot play. Their word is
   * not taken as is: YouTube is asked again, and only a video that really does not play here
   * is skipped (and never picked again). Matters most when the room has no player device:
   * nobody else would notice, and the room would "play" a silent song to its end.
   */
  async listenerUnplayable(
    actor: Actor,
    input: CommandInput<'listen:unplayable'>,
  ): Promise<void> {
    if (!UNPLAYABLE_CODES.includes(input.errorCode)) return;
    const ps = await this.prisma.playbackState.findUnique({
      where: { roomId: actor.roomId },
    });
    if (!ps || ps.currentItemId !== input.queueItemId) return;
    const item = await this.prisma.queueItem.findUnique({
      where: { id: input.queueItemId },
      include: { track: { select: { title: true, externalId: true } } },
    });
    if (!item) return;
    if (await this.tracks.recheck(item.track.externalId)) return;
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      // STALE_ITEM: the room moved on meanwhile (someone skipped, the player reported).
      await this.advance(tx, ctx, actor.roomId, input.queueItemId, 'error');
      await this.activity.log(
        tx,
        ctx,
        actor.roomId,
        null,
        'track_error',
        `Bỏ qua "${item.track.title}" vì video không phát được ở đây (mã ${input.errorCode})`,
        { title: item.track.title, code: input.errorCode },
      );
    });
  }

  // ------------------------------------------------------------ side effects

  private async afterChange(roomId: string): Promise<void> {
    await this.scheduleTimer(roomId);
    await this.sendPlayerCommand(roomId);
  }

  async buildPlayerCommand(roomId: string): Promise<PlayerCommand> {
    void this.warmWishes(roomId);
    const ps = await this.prisma.playbackState.findUniqueOrThrow({
      where: { roomId },
    });
    const now = Date.now();
    const item = ps.currentItemId
      ? await this.prisma.queueItem.findUnique({
          where: { id: ps.currentItemId },
          include: { track: true },
        })
      : null;
    // AI3: a wish is read instead of the MC line, never both.
    const intro =
      item && !item.wishMessage && item.addedById && (await this.mcOn(roomId))
        ? this.mc.lineFor(item.id)
        : null;
    const line = item?.wishMessage
      ? { text: item.wishMessage, voice: voiceOf(item.voicePreset) }
      : intro
        ? { text: intro, voice: 'male' as const }
        : null;
    const speech = line ? this.tts.speech(line.text, line.voice) : null;
    if (item && line && speech?.pending)
      this.resendWhenReady(roomId, item.id, line.text, line.voice);
    return {
      queueItemId: item?.id ?? null,
      videoId: item?.track.externalId ?? null,
      status: item ? ps.status : 'IDLE',
      positionSec: estimatePosition(ps, now),
      positionAt: now,
      wish: item?.wishMessage
        ? {
            message: item.wishMessage,
            voicePreset: null,
          }
        : null,
      intro,
      speech,
    };
  }

  /**
   * The song started before its line's Edge audio was ready (the speaker holds the line a few
   * seconds): once it is, send the command again (speaker) and the snapshot (listen-along).
   */
  private resendWhenReady(
    roomId: string,
    itemId: string,
    text: string,
    voice: Voice,
  ): void {
    const id = `${roomId} ${itemId}`;
    if (this.awaitingSpeech.has(id)) return;
    this.awaitingSpeech.add(id);
    void this.tts
      .whenReady(text, voice)
      .then(async (key) => {
        if (!key) return;
        const ps = await this.prisma.playbackState.findUnique({
          where: { roomId },
          select: { currentItemId: true },
        });
        if (ps?.currentItemId !== itemId) return;
        await this.sendPlayerCommand(roomId);
        await this.state.touch(roomId);
      })
      .catch((e: unknown) =>
        this.logger.warn(`Re-sending the wish audio failed: ${String(e)}`),
      )
      .finally(() => this.awaitingSpeech.delete(id));
  }

  /**
   * Edge audio lives in memory: after a restart (deploy, Render waking up) the waiting wishes
   * have none. Remake it ahead of their turn, at most once a minute per room.
   */
  private async warmWishes(roomId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.warmedAt.get(roomId) ?? 0) < WARM_EVERY_MS) return;
    this.warmedAt.set(roomId, now);
    try {
      const items = await this.prisma.queueItem.findMany({
        where: { roomId, status: 'QUEUED', wishMessage: { not: null } },
        select: { wishMessage: true, voicePreset: true },
        orderBy: { addedAt: 'asc' },
        take: WARM_MAX,
      });
      for (const i of items)
        if (i.wishMessage)
          void this.tts.prepare(i.wishMessage, voiceOf(i.voicePreset));
    } catch (e) {
      this.logger.warn(
        `Warming wishes for room ${roomId} failed: ${String(e)}`,
      );
    }
  }

  private async mcOn(roomId: string): Promise<boolean> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: { settings: true },
    });
    return Boolean(room && readSettings(room.settings).mcIntro);
  }

  async sendPlayerCommand(roomId: string): Promise<void> {
    const holder = this.lease.holder(roomId);
    if (!holder) return;
    this.broadcaster.toSocket(
      holder.socketId,
      'player:command',
      await this.buildPlayerCommand(roomId),
    );
  }

  /** R-30: server-side safety net at duration + grace. */
  async scheduleTimer(roomId: string): Promise<void> {
    const old = this.timers.get(roomId);
    if (old) clearTimeout(old);
    this.timers.delete(roomId);
    const ps = await this.prisma.playbackState.findUnique({
      where: { roomId },
    });
    if (!ps?.currentItemId || ps.status !== 'PLAYING') return;
    const item = await this.prisma.queueItem.findUnique({
      where: { id: ps.currentItemId },
      include: { track: { select: { durationSec: true } } },
    });
    const duration = item?.track.durationSec;
    if (!duration) return;
    const remainingMs =
      (duration - estimatePosition(ps, Date.now())) * 1000 +
      this.timing.advanceGraceMs;
    const itemId = ps.currentItemId;
    const t = setTimeout(
      () => void this.onTimer(roomId, itemId),
      Math.max(0, remainingMs),
    );
    t.unref();
    this.timers.set(roomId, t);
  }

  private async onTimer(roomId: string, itemId: string): Promise<void> {
    this.timers.delete(roomId);
    try {
      await this.state.mutate(roomId, (tx, ctx) =>
        this.advance(tx, ctx, roomId, itemId, 'timer'),
      );
    } catch (e) {
      // STALE_ITEM: the song changed meanwhile — possibly in another instance (a deploy),
      // whose timer for the new song dies with it: time the song now on air from here too.
      if (e instanceof AppError && e.code === 'STALE_ITEM') {
        if (!this.state.isClosing) await this.scheduleTimer(roomId);
        return;
      }
      // ROOM_NOT_FOUND: the room was just deleted. Anything else: the watchdog retries.
      const expected = e instanceof AppError && e.code === 'ROOM_NOT_FOUND';
      if (!expected && !this.state.isClosing) {
        this.logger.error(`advance timer failed for ${roomId}: ${String(e)}`);
      }
    }
  }

  /**
   * The safety net under the end-of-song timers: a playing song well past its end (timer
   * lost or its advance failed) is advanced now. Several instances may sweep at once: the
   * room lock and STALE_ITEM let only one advance.
   */
  async sweepOverdue(): Promise<void> {
    if (this.state.isClosing) return;
    try {
      const playing = await this.prisma.playbackState.findMany({
        where: { status: 'PLAYING', currentItemId: { not: null } },
      });
      if (!playing.length) return;
      const items = await this.prisma.queueItem.findMany({
        where: { id: { in: playing.map((p) => p.currentItemId!) } },
        select: { id: true, track: { select: { durationSec: true } } },
      });
      const duration = new Map(
        items.map((i) => [i.id, i.track.durationSec] as const),
      );
      const now = Date.now();
      for (const ps of playing) {
        const d = duration.get(ps.currentItemId!);
        if (!d) continue;
        const overdueMs =
          (estimatePosition(ps, now) - d) * 1000 - this.timing.advanceGraceMs;
        // Past the timer's own moment by more than a sweep: that timer is not coming.
        if (overdueMs > WATCHDOG_EVERY_MS) {
          this.logger.warn(
            `room ${ps.roomId}: song ended ${Math.round(overdueMs / 1000)}s ago without advancing; advancing now`,
          );
          await this.onTimer(ps.roomId, ps.currentItemId!);
        }
      }
    } catch (e) {
      if (!this.state.isClosing)
        this.logger.error(`overdue sweep failed: ${String(e)}`);
    }
  }

  private armVoteTimer(roomId: string, itemId: string, endsAt: number): void {
    this.clearVoteTimer(roomId);
    const t = setTimeout(
      () => void this.onVoteTimer(roomId, itemId),
      // A little late rather than early, so the deadline has surely passed.
      Math.max(0, endsAt - Date.now() + 100),
    );
    t.unref();
    this.voteTimers.set(roomId, t);
  }

  private clearVoteTimer(roomId: string): void {
    const t = this.voteTimers.get(roomId);
    if (t) clearTimeout(t);
    this.voteTimers.delete(roomId);
  }

  private async onVoteTimer(roomId: string, itemId: string): Promise<void> {
    this.voteTimers.delete(roomId);
    try {
      await this.state.mutate(roomId, async (tx, ctx) => {
        const ps = await tx.playbackState.findUniqueOrThrow({
          where: { roomId },
        });
        if (ps.currentItemId === itemId)
          await this.reevaluateSkip(tx, ctx, roomId);
      });
    } catch (e) {
      const gone = e instanceof AppError && e.code === 'ROOM_NOT_FOUND';
      if (!this.state.isClosing && !gone)
        this.logger.error(`skip vote timer failed for ${roomId}: ${String(e)}`);
    }
  }

  /** Re-arms timers after a restart; advances items that ended while we were down (TC-108). */
  async restore(): Promise<void> {
    const playing = await this.prisma.playbackState.findMany({
      where: { status: 'PLAYING' },
      select: { roomId: true },
    });
    for (const { roomId } of playing) await this.scheduleTimer(roomId);
    // V1: open skip votes (a vote that ended while we were down is settled at once).
    const votes = await this.prisma.queueItem.findMany({
      where: { status: 'PLAYING', skipVoteEndsAt: { not: null } },
      select: { id: true, roomId: true, skipVoteEndsAt: true },
    });
    for (const v of votes)
      this.armVoteTimer(v.roomId, v.id, v.skipVoteEndsAt!.getTime());
    if (playing.length)
      this.logger.log(`Restored ${playing.length} playing room(s)`);
  }
}
