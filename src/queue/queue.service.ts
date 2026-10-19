import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error';
import { RateLimiter } from '../common/rate-limiter';
import {
  type CommandInput,
  type CommandResults,
  type ErrorCode,
  parseYouTubeVideo,
  type RoomSettings,
} from '../contracts';
import type { Member, QueueItem, Track } from '../generated/prisma/client';
import { ModerationService } from '../ai/moderation.service';
import { TtsService } from '../tts/tts.service';
import { TrackCacheService } from '../music/track-cache.service';
import { PlaybackService } from '../playback/playback.service';
import { isBlocked } from './block.service';
import type { Tx } from '../prisma/prisma.service';
import { ActivityService } from '../social/activity.service';
import {
  type Actor,
  type MutateCtx,
  RoomStateService,
} from '../state/room-state.service';
import { PrismaService } from '../prisma/prisma.service';
import { readSettings } from '../state/settings';

const TRACK_ID = /^youtube:([A-Za-z0-9_-]{11})$/;

/** "youtube:<id>" from search results, or any supported link (R-15). */
export function resolveVideoId(input: string): string {
  const fromSearch = TRACK_ID.exec(input.trim());
  if (fromSearch) return fromSearch[1];
  const parsed = parseYouTubeVideo(input);
  if (!parsed) throw new AppError('LINK_UNSUPPORTED');
  return parsed.videoId;
}

type ItemWithTrack = QueueItem & { track: Track };

/** Each add may cost YouTube quota; 20 per minute per member is plenty for humans. */
export const ADD_LIMIT = { count: 20, windowMs: 60_000 };

/** First song of an idle room added with a wish: how long the add waits for its Edge voice. */
const IDLE_WISH_WAIT_MS = 4000;

@Injectable()
export class QueueService {
  readonly limiter = new RateLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: RoomStateService,
    private readonly tracks: TrackCacheService,
    private readonly playback: PlaybackService,
    private readonly activity: ActivityService,
    private readonly moderation: ModerationService,
    private readonly tts: TtsService,
  ) {}

  /** Loads a queue item of the actor's room or throws STALE_ITEM. */
  private async item(
    tx: Tx,
    roomId: string,
    id: string,
  ): Promise<ItemWithTrack> {
    const item = await tx.queueItem.findUnique({
      where: { id },
      include: { track: true },
    });
    if (!item || item.roomId !== roomId) throw new AppError('STALE_ITEM');
    return item;
  }

  private requireQueued(item: QueueItem): void {
    if (item.status !== 'QUEUED') throw new AppError('STALE_ITEM');
  }

  /**
   * Room rules for one song a member adds: length (R-17) and duplicates (A6). A song
   * already waiting or on air is always refused; one that started within
   * repeatGapMinutes is refused too, except for admins.
   */
  private async checkAddable(
    tx: Tx,
    roomId: string,
    me: Member,
    track: Track,
    settings: RoomSettings,
    now: Date,
  ): Promise<void> {
    // Blocked by the admin: refused for everyone, the admin included.
    if (await isBlocked(tx, roomId, track.id))
      throw new AppError('TRACK_BLOCKED');
    const max = settings.maxTrackDurationSec;
    if (max > 0 && track.durationSec !== null && track.durationSec > max) {
      throw new AppError('TRACK_TOO_LONG', {
        duration: track.durationSec,
        max,
      });
    }
    const waiting = await tx.queueItem.count({
      where: {
        roomId,
        trackId: track.id,
        status: { in: ['QUEUED', 'PLAYING'] },
      },
    });
    if (waiting > 0) throw new AppError('ALREADY_QUEUED');
    const gap = settings.repeatGapMinutes;
    if (gap > 0 && me.role !== 'ADMIN') {
      const last = await tx.queueItem.findFirst({
        where: {
          roomId,
          trackId: track.id,
          startedAt: { gte: new Date(now.getTime() - gap * 60_000) },
        },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      });
      if (last?.startedAt) {
        const minutes = Math.max(
          1,
          Math.round((now.getTime() - last.startedAt.getTime()) / 60_000),
        );
        throw new AppError('PLAYED_RECENTLY', { minutes, gap });
      }
    }
  }

  /**
   * `upvote`: a song another member already queued gets this member's heart instead
   * (the web's add). The DJ leaves it off: it needs ALREADY_QUEUED to try the next upload.
   */
  async add(
    actor: Actor,
    input: CommandInput<'queue:add'>,
    opts: { upvote?: boolean } = {},
  ): Promise<CommandResults['queue:add']> {
    const videoId = resolveVideoId(input.input);
    const rl = this.limiter.hit(
      `add:${actor.memberId}`,
      ADD_LIMIT.count,
      ADD_LIMIT.windowMs,
      Date.now(),
    );
    if (!rl.ok)
      throw new AppError('RATE_LIMITED', { seconds: rl.retryAfterSec });
    // Before the queue limit: an upvote adds nothing of the member's own.
    if (opts.upvote) {
      const upvoted = await this.upvote(actor, `youtube:${videoId}`);
      if (upvoted) return upvoted;
    }
    // Cheap pre-check so a member at the limit cannot burn YouTube quota (re-checked in the tx).
    const room = await this.prisma.room.findUniqueOrThrow({
      where: { id: actor.roomId },
    });
    const max = readSettings(room.settings).maxQueuedPerMember;
    const queued = await this.prisma.queueItem.count({
      where: {
        roomId: actor.roomId,
        addedById: actor.memberId,
        status: 'QUEUED',
      },
    });
    if (queued >= max) throw new AppError('QUEUE_LIMIT', { max });
    // Before looking the video up: a blocked one must not cost YouTube quota.
    if (await isBlocked(this.prisma, actor.roomId, `youtube:${videoId}`))
      throw new AppError('TRACK_BLOCKED');
    // Network work (track lookup, AI4 wish check) happens outside the room lock.
    await this.moderation.checkWish(input.wishMessage);
    // The wish's Edge voice is started now, before the write.
    const voiceReady = input.wishMessage
      ? this.tts.prepare(input.wishMessage, input.voice ?? 'male')
      : null;
    const track = await this.tracks.resolve(videoId);
    // An idle room plays this song at once: only there, the add waits (at most
    // IDLE_WISH_WAIT_MS) for the voice, so the first song's wish is read in the Edge voice.
    // Everywhere else nothing waits; a late voice is still read over the song's start.
    if (voiceReady && (await this.idle(actor.roomId)))
      await this.within(voiceReady, IDLE_WISH_WAIT_MS);

    return this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.state.activeMember(tx, actor);
      if (me.isDevice) throw new AppError('FORBIDDEN');
      const room = await tx.room.findUniqueOrThrow({
        where: { id: actor.roomId },
      });
      const settings = readSettings(room.settings);

      const mine = await tx.queueItem.count({
        where: { roomId: actor.roomId, addedById: me.id, status: 'QUEUED' },
      });
      if (mine >= settings.maxQueuedPerMember) {
        throw new AppError('QUEUE_LIMIT', { max: settings.maxQueuedPerMember });
      }
      await this.checkAddable(tx, actor.roomId, me, track, settings, ctx.now);

      const wish = input.wishMessage ? input.wishMessage : null;
      const item = await tx.queueItem.create({
        data: {
          roomId: actor.roomId,
          trackId: track.id,
          addedById: me.id,
          status: 'QUEUED',
          wishMessage: wish,
          voicePreset: wish ? (input.voice ?? 'male') : null,
        },
      });
      await this.activity.log(
        tx,
        ctx,
        actor.roomId,
        me,
        'track_add',
        `đã thêm "${track.title}"`,
        { variant: 'one', title: track.title },
      );
      await this.playback.startIfIdle(tx, ctx, actor.roomId);
      return { queueItemId: item.id, title: track.title };
    });
  }

  /**
   * A5: several known songs (from a playlist) in the order given, until the member's
   * queue limit. Songs the room's rules refuse are skipped with the reason; the fair
   * queue still interleaves them with everyone else's.
   */
  async addMany(
    actor: Actor,
    trackIds: string[],
  ): Promise<CommandResults['queue:add-many']> {
    const rl = this.limiter.hit(
      `add:${actor.memberId}`,
      ADD_LIMIT.count,
      ADD_LIMIT.windowMs,
      Date.now(),
    );
    if (!rl.ok)
      throw new AppError('RATE_LIMITED', { seconds: rl.retryAfterSec });
    const ids = [...new Set(trackIds)];
    const known = await this.prisma.track.findMany({
      where: { id: { in: ids }, embeddable: true, title: { not: '' } },
    });
    const byId = new Map(known.map((t) => [t.id, t]));

    return this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.state.activeMember(tx, actor);
      if (me.isDevice) throw new AppError('FORBIDDEN');
      const room = await tx.room.findUniqueOrThrow({
        where: { id: actor.roomId },
      });
      const settings = readSettings(room.settings);
      let mine = await tx.queueItem.count({
        where: { roomId: actor.roomId, addedById: me.id, status: 'QUEUED' },
      });
      const skipped: { trackId: string; reason: ErrorCode }[] = [];
      const titles: string[] = [];
      for (const id of ids) {
        const track = byId.get(id);
        if (!track) {
          skipped.push({ trackId: id, reason: 'TRACK_NOT_FOUND' });
          continue;
        }
        if (mine >= settings.maxQueuedPerMember) {
          skipped.push({ trackId: id, reason: 'QUEUE_LIMIT' });
          continue;
        }
        try {
          await this.checkAddable(
            tx,
            actor.roomId,
            me,
            track,
            settings,
            ctx.now,
          );
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          skipped.push({ trackId: id, reason: e.code });
          continue;
        }
        await tx.queueItem.create({
          data: {
            roomId: actor.roomId,
            trackId: track.id,
            addedById: me.id,
            status: 'QUEUED',
          },
        });
        mine += 1;
        titles.push(track.title);
      }
      if (titles.length) {
        await this.activity.log(
          tx,
          ctx,
          actor.roomId,
          me,
          'track_add',
          titles.length === 1
            ? `đã thêm "${titles[0]}"`
            : `đã thêm ${titles.length} bài từ playlist`,
          titles.length === 1
            ? { variant: 'one', title: titles[0] }
            : { variant: 'playlist', count: titles.length },
        );
        await this.playback.startIfIdle(tx, ctx, actor.roomId);
      }
      return { added: titles.length, skipped };
    });
  }

  async remove(actor: Actor, queueItemId: string): Promise<void> {
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.state.activeMember(tx, actor);
      const item = await this.item(tx, actor.roomId, queueItemId);
      if (item.addedById !== me.id && me.role !== 'ADMIN')
        throw new AppError('FORBIDDEN');
      this.requireQueued(item);
      await tx.queueItem.update({
        where: { id: item.id },
        data: { status: 'REMOVED' },
      });
      await this.activity.log(
        tx,
        ctx,
        actor.roomId,
        me,
        'track_remove',
        `đã xóa "${item.track.title}"`,
        { title: item.track.title },
      );
    });
  }

  /** R-21: toggle "Phát tiếp theo". */
  async pinNext(actor: Actor, queueItemId: string): Promise<void> {
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.state.activeMember(tx, actor);
      if (me.role !== 'ADMIN' && !me.canControl)
        throw new AppError('FORBIDDEN');
      const item = await this.item(tx, actor.roomId, queueItemId);
      this.requireQueued(item);
      const pin = item.pinnedAt === null;
      await tx.queueItem.update({
        where: { id: item.id },
        data: { pinnedAt: pin ? ctx.now : null },
      });
      await this.activity.log(
        tx,
        ctx,
        actor.roomId,
        me,
        'track_pin',
        pin
          ? `đã ghim "${item.track.title}" phát tiếp theo`
          : `đã bỏ ghim "${item.track.title}"`,
        { variant: pin ? 'pin' : 'unpin', title: item.track.title },
      );
    });
  }

  /** R-22: one heart per member across QUEUED items; same item again removes it. */
  async heart(actor: Actor, queueItemId: string): Promise<void> {
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.state.activeMember(tx, actor);
      if (me.isDevice) throw new AppError('FORBIDDEN');
      const item = await this.item(tx, actor.roomId, queueItemId);
      this.requireQueued(item);
      // Hearts lift other people's songs; the picker cannot vote for their own.
      if (item.addedById === me.id) throw new AppError('OWN_SONG');
      const existing = await tx.heart.findUnique({
        where: { queueItemId_memberId: { queueItemId, memberId: me.id } },
      });
      if (existing) await this.dropHeart(tx, actor.roomId, me);
      else await this.giveHeart(tx, ctx, actor.roomId, me, item);
    });
  }

  /**
   * Adding a song someone else already queued hearts it instead: the request becomes an
   * upvote, never a refusal. Null when no other member's copy is waiting (add as usual);
   * the member's own copy, or one on air, still gives ALREADY_QUEUED.
   */
  private async upvote(
    actor: Actor,
    trackId: string,
  ): Promise<CommandResults['queue:add'] | null> {
    return this.state.mutate(actor.roomId, async (tx, ctx) => {
      const item = await tx.queueItem.findFirst({
        where: { roomId: actor.roomId, trackId, status: 'QUEUED' },
        include: { track: true },
      });
      if (!item) return null;
      const me = await this.state.activeMember(tx, actor);
      if (me.isDevice) throw new AppError('FORBIDDEN');
      if (item.addedById === me.id) throw new AppError('ALREADY_QUEUED');
      const existing = await tx.heart.findUnique({
        where: {
          queueItemId_memberId: { queueItemId: item.id, memberId: me.id },
        },
      });
      // Already hearted: asking again keeps it (unlike the heart button, which toggles).
      if (!existing) await this.giveHeart(tx, ctx, actor.roomId, me, item);
      return { queueItemId: item.id, title: item.track.title, upvoted: true };
    });
  }

  private async dropHeart(tx: Tx, roomId: string, me: Member): Promise<void> {
    await tx.heart.deleteMany({
      where: { memberId: me.id, queueItem: { roomId, status: 'QUEUED' } },
    });
  }

  /** Moves the member's one heart onto `item`. */
  private async giveHeart(
    tx: Tx,
    ctx: MutateCtx,
    roomId: string,
    me: Member,
    item: ItemWithTrack,
  ): Promise<void> {
    await this.dropHeart(tx, roomId, me);
    await tx.heart.create({ data: { queueItemId: item.id, memberId: me.id } });
    await this.activity.log(
      tx,
      ctx,
      roomId,
      me,
      'track_heart',
      `đã thả tim "${item.track.title}"`,
      { title: item.track.title },
    );
  }

  async setMessage(
    actor: Actor,
    input: CommandInput<'queue:set-message'>,
  ): Promise<void> {
    await this.moderation.checkWish(input.wishMessage);
    await this.state.mutate(actor.roomId, async (tx) => {
      const me = await this.state.activeMember(tx, actor);
      const item = await this.item(tx, actor.roomId, input.queueItemId);
      if (item.addedById !== me.id) throw new AppError('FORBIDDEN');
      this.requireQueued(item);
      const wish = input.wishMessage || null;
      await tx.queueItem.update({
        where: { id: item.id },
        data: {
          wishMessage: wish,
          voicePreset: wish ? (input.voice ?? 'male') : null,
        },
      });
    });
    // Made ahead so the speaker has it when the song starts; never awaited.
    if (input.wishMessage)
      void this.tts.prepare(input.wishMessage, input.voice ?? 'male');
  }

  /** Nothing is playing (or about to): an added song would start at once. */
  private async idle(roomId: string): Promise<boolean> {
    const ps = await this.prisma.playbackState.findUnique({
      where: { roomId },
      select: { currentItemId: true },
    });
    return !ps?.currentItemId;
  }

  /** Waits for `p`, but never longer than `ms`. */
  private async within(p: Promise<unknown>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      p,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  /** R-10: kicked members' waiting tracks are removed. */
  async removeAllOf(tx: Tx, roomId: string, member: Member): Promise<void> {
    await tx.queueItem.updateMany({
      where: { roomId, addedById: member.id, status: 'QUEUED' },
      data: { status: 'REMOVED' },
    });
  }
}
