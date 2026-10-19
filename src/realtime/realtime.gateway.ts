import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import { AppError } from '../common/app-error';
import { RateLimiter } from '../common/rate-limiter';
import { ENV, type Env } from '../config/env';
import {
  type Ack,
  ANONYMOUS_COMMANDS,
  C2S,
  type CommandInput,
  type CommandName,
} from '../contracts';
import { DjBrainService } from '../dj/dj-brain.service';
import { WishWriterService } from '../ai/wish-writer.service';
import { LibraryService } from '../library/library.service';
import { MembersService, type Session } from '../members/members.service';
import { YouTubeAccountService } from '../music/youtube-account.service';
import { PlaylistsService } from '../playlists/playlists.service';
import { TasteService } from '../taste/taste.service';
import { UsersService } from '../users/users.service';
import { SearchService } from '../music/search.service';
import { SongListService } from '../music/songlist.service';
import { LyricsService } from '../music/lyrics.service';
import { PlaylistService } from '../music/playlist.service';
import { SuggestService } from '../music/suggest.service';
import { readSettings } from '../state/settings';
import { PlaybackService } from '../playback/playback.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { BlockService } from '../queue/block.service';
import { ActivityService } from '../social/activity.service';
import { SocialService } from '../social/social.service';
import { type Actor, RoomStateService } from '../state/room-state.service';
import { RoomActivityService } from '../rooms/room-activity.service';
import { RoomDeletionService } from '../rooms/room-deletion.service';
import { SnapshotService } from '../state/snapshot.service';
import { Broadcaster, roomChannel } from './broadcaster.service';
import { PresenceService } from './presence.service';

/**
 * Commands that do not mark the room as used: the players' automatic reports, and
 * deleting the room (nothing left to mark).
 */
const AUTOMATIC_COMMANDS: ReadonlySet<string> = new Set([
  'player:report',
  'player:heartbeat',
  'listen:unplayable',
  'room:delete',
]);

interface Bound {
  memberId: string;
  roomId: string;
  code: string;
}

interface SocketData {
  ip: string;
  bound?: Bound;
  invalidToken?: boolean;
  /** L1: the Google account signed in on this socket. */
  userId?: string;
}

type AppSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

/** R-43: account-creating commands per IP per minute (JOIN_LIMIT_PER_MINUTE, default 20). */
const IP_WINDOW_MS = 60_000;
/** Extra throttles (review): PIN guesses per member, room-code lookups per IP. */
export const CLAIM_LIMIT = { count: 10, windowMs: 60_000 };
export const PEEK_LIMIT = { count: 60, windowMs: 60_000 };
/** Each saved wish makes an Edge voice (a Python process): keep it to normal use. */
export const WISH_LIMIT = { count: 10, windowMs: 60_000 };
/** tracks:lookup may call YouTube for unknown ids: a few per minute is plenty. */
export const LOOKUP_LIMIT = { count: 10, windowMs: 60_000 };
/** Lyrics are asked once per song per device (cached on the server). */
export const LYRICS_LIMIT = { count: 20, windowMs: 60_000 };
/** AI2: free AI quota is shared by the whole server. */
/** "Nhờ MC viết": one short AI call each, same shared free quota. */
export const WISH_AI_LIMIT = { count: 10, windowMs: 3600_000 };
export const RECAP_LIMIT = { count: 20, windowMs: 60_000 };
/** L2: adding songs / creating playlists, per account. */
export const PLAYLIST_WRITE_LIMIT = { count: 60, windowMs: 60_000 };
/** L3: each import reads up to ~10 pages from YouTube. */
export const YT_IMPORT_LIMIT = { count: 20, windowMs: 600_000 };
/** L4: pasted lists (YouTube searches inside have their own hourly limit). */
export const SONGLIST_LIMIT = { count: 20, windowMs: 600_000 };
/** V1: skip votes (✅ / ❌ can be changed while a vote is open). */
export const VOTE_LIMIT = { count: 20, windowMs: 60_000 };
export const LISTEN_LIMIT = { count: 20, windowMs: 60_000 };

export function clientIp(socket: Socket, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return socket.handshake.address;
}

@WebSocketGateway()
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);
  readonly ipLimiter = new RateLimiter();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
    private readonly queue: QueueService,
    private readonly blocks: BlockService,
    private readonly playback: PlaybackService,
    private readonly social: SocialService,
    private readonly search: SearchService,
    private readonly activity: ActivityService,
    private readonly state: RoomStateService,
    private readonly snapshots: SnapshotService,
    private readonly presence: PresenceService,
    private readonly broadcaster: Broadcaster,
    private readonly library: LibraryService,
    private readonly suggest: SuggestService,
    private readonly playlists: PlaylistService,
    private readonly lyrics: LyricsService,
    private readonly djBrain: DjBrainService,
    private readonly wishWriter: WishWriterService,
    private readonly users: UsersService,
    private readonly personal: PlaylistsService,
    private readonly youtubeAccount: YouTubeAccountService,
    private readonly taste: TasteService,
    private readonly songlist: SongListService,
    private readonly roomActivity: RoomActivityService,
    private readonly roomDeletion: RoomDeletionService,
  ) {}

  // ------------------------------------------------------------ lifecycle

  afterInit(server: Server): void {
    this.broadcaster.attach(server);
    server.use((socket, next) => {
      const s = socket as AppSocket;
      s.data.ip = clientIp(socket, this.env.TRUST_PROXY);
      const auth = socket.handshake.auth as
        | { token?: unknown; userToken?: unknown }
        | undefined;
      void (async () => {
        // L1: an account token signs the socket in; a bad one is simply ignored.
        if (auth?.userToken) {
          const user = await this.users.resolve(auth.userToken);
          if (user) s.data.userId = user.id;
        }
        if (auth?.token) {
          const r = await this.members.resume(auth.token);
          if (r)
            s.data.bound = {
              memberId: r.member.id,
              roomId: r.member.roomId,
              code: r.code,
            };
          else s.data.invalidToken = true;
        }
        // A guest session opened by a signed-in browser becomes the account's member.
        if (s.data.bound && s.data.userId)
          await this.members.linkMember(s.data.bound.memberId, s.data.userId);
      })()
        .then(() => next())
        .catch((e: unknown) => {
          this.logger.error(`handshake failed: ${String(e)}`);
          next(new Error('INTERNAL'));
        });
    });
  }

  async handleConnection(socket: AppSocket): Promise<void> {
    if (socket.data.bound) {
      await this.bind(socket, socket.data.bound).catch((e: unknown) => {
        if (!this.state.isClosing)
          this.logger.error(`bind failed: ${String(e)}`);
      });
    } else if (socket.data.invalidToken) {
      socket.emit('session:revoked', { reason: 'invalid' });
    }
  }

  async handleDisconnect(socket: AppSocket): Promise<void> {
    await this.unbind(socket);
  }

  private async bind(socket: AppSocket, b: Bound): Promise<void> {
    socket.data.bound = b;
    // Opening / reopening the room counts as using it (orphan room cleanup).
    this.roomActivity.touch(b.roomId);
    await socket.join(roomChannel(b.roomId));
    const cameOnline = this.presence.add(b.memberId, b.roomId, socket.id);
    socket.emit('session:ready', { memberId: b.memberId, code: b.code });
    const [chat, logs] = await Promise.all([
      this.social.chatHistory(b.roomId),
      this.activity.history(b.roomId),
    ]);
    socket.emit('chat:history', chat);
    socket.emit('activity:history', logs);
    await this.library.pushIds(b.memberId);
    if (cameOnline) {
      // Presence changed: re-check vote thresholds (R-25) and broadcast to everyone.
      await this.state.mutate(b.roomId, (tx, ctx) =>
        this.playback.reevaluateSkip(tx, ctx, b.roomId),
      );
    } else {
      const snap = await this.snapshots.build(b.roomId);
      if (snap) socket.emit('room:update', snap);
    }
  }

  private async unbind(socket: AppSocket): Promise<void> {
    const b = socket.data.bound;
    socket.data.bound = undefined;
    if (!b) return;
    await socket.leave(roomChannel(b.roomId));
    const r = this.presence.remove(socket.id);
    // Still online elsewhere but no longer listening: others' "🎧" lists must update.
    if (r?.stoppedListening && !r.wentOffline && !this.state.isClosing) {
      await this.state
        .touch(b.roomId)
        .catch((e: unknown) =>
          this.logger.warn(`presence update failed: ${String(e)}`),
        );
    }
    if (r?.wentOffline && !this.state.isClosing) {
      await this.state
        .mutate(b.roomId, (tx, ctx) =>
          this.playback.reevaluateSkip(tx, ctx, b.roomId),
        )
        .catch((e: unknown) =>
          this.logger.warn(`presence update failed: ${String(e)}`),
        );
    }
  }

  // ------------------------------------------------------------ plumbing

  private actor(socket: AppSocket): Actor | null {
    const b = socket.data.bound;
    return b
      ? {
          memberId: b.memberId,
          roomId: b.roomId,
          socketId: socket.id,
          ip: socket.data.ip,
          userId: socket.data.userId,
        }
      : null;
  }

  /** Validate (R-42), authenticate (R-09), run, and turn errors into acks. */
  private async run<K extends CommandName, R>(
    name: K,
    socket: AppSocket,
    body: unknown,
    handler: (input: CommandInput<K>, actor: Actor) => Promise<R>,
  ): Promise<Ack<R extends void ? Record<string, never> : R>> {
    try {
      const actor = this.actor(socket);
      if (!actor && !ANONYMOUS_COMMANDS.includes(name))
        throw new AppError('UNAUTHENTICATED');
      const parsed = C2S[name].safeParse(body ?? {});
      if (!parsed.success) throw new AppError('VALIDATION');
      const data = await handler(
        parsed.data as CommandInput<K>,
        actor as Actor,
      );
      // A person did something in the room (the speaker page's reports are automatic).
      if (actor && !AUTOMATIC_COMMANDS.has(name))
        this.roomActivity.touch(actor.roomId);
      return {
        ok: true,
        data: (data ?? {}) as R extends void ? Record<string, never> : R,
      };
    } catch (e) {
      if (e instanceof AppError) {
        return {
          ok: false,
          error: { code: e.code, ...(e.params ? { params: e.params } : {}) },
        };
      }
      this.logger.error(
        `${name} failed: ${e instanceof Error ? e.stack : String(e)}`,
      );
      return { ok: false, error: { code: 'INTERNAL' } };
    }
  }

  private limit(key: string, rule: { count: number; windowMs: number }): void {
    const r = this.ipLimiter.hit(key, rule.count, rule.windowMs, Date.now());
    if (!r.ok) throw new AppError('RATE_LIMITED', { seconds: r.retryAfterSec });
  }

  private limitIp(socket: AppSocket): void {
    const r = this.ipLimiter.hit(
      `ip:${socket.data.ip}`,
      this.env.JOIN_LIMIT_PER_MINUTE,
      IP_WINDOW_MS,
      Date.now(),
    );
    if (!r.ok) throw new AppError('RATE_LIMITED', { seconds: r.retryAfterSec });
  }

  private async enter(socket: AppSocket, session: Session) {
    await this.unbind(socket);
    await this.bind(socket, {
      memberId: session.memberId,
      roomId: session.roomId,
      code: session.code,
    });
    return {
      token: session.token,
      code: session.code,
      memberId: session.memberId,
    };
  }

  /** Loads the actor and rejects player devices (search is a member action — PM-16). */
  private async requireMember(actor: Actor): Promise<void> {
    const m = await this.prisma.member.findUnique({
      where: { id: actor.memberId },
    });
    if (!m || m.leftAt || m.kickedAt) throw new AppError('UNAUTHENTICATED');
    if (m.isDevice) throw new AppError('FORBIDDEN');
  }

  // ------------------------------------------------------------ rooms & identity

  @SubscribeMessage('room:create')
  create(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('room:create', s, body, async (input) => {
      this.limitIp(s);
      return this.enter(s, await this.members.create(input, s.data.userId));
    });
  }

  @SubscribeMessage('room:peek')
  peek(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('room:peek', s, body, (input) => {
      this.limit(`peek:${s.data.ip}`, PEEK_LIMIT);
      return this.members.peek(input.code);
    });
  }

  @SubscribeMessage('room:join')
  join(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('room:join', s, body, async (input) => {
      this.limitIp(s);
      const session = await this.members.join(input, s.data.ip, s.data.userId);
      return {
        ...(await this.enter(s, session)),
        rejoined: session.rejoined,
        rightsReset: session.rightsReset,
      };
    });
  }

  @SubscribeMessage('host:register')
  registerHost(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('host:register', s, body, async (input) => {
      this.limitIp(s);
      return this.enter(s, await this.members.registerHost(input));
    });
  }

  @SubscribeMessage('room:leave')
  leave(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('room:leave', s, body, async (_i, actor) => {
      // Unbind this socket first so the ack still reaches it; other tabs get session:revoked.
      await this.unbind(s);
      await this.members.leave(actor);
    });
  }

  @SubscribeMessage('admin:claim')
  claimAdmin(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('admin:claim', s, body, (input, actor) => {
      this.limit(`claim:${actor.memberId}`, CLAIM_LIMIT);
      return this.members.claimAdmin(actor, input.pin, s.data.ip);
    });
  }

  @SubscribeMessage('room:claim-owner')
  claimOwner(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('room:claim-owner', s, body, (_input, actor) =>
      this.members.claimOwner(actor, this.requireUser(s)),
    );
  }

  @SubscribeMessage('room:set-pin')
  setPin(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('room:set-pin', s, body, (input, actor) => {
      this.limit(`claim:${actor.memberId}`, CLAIM_LIMIT);
      return this.members.setPin(actor, input.pin);
    });
  }

  @SubscribeMessage('permission:set')
  setPermission(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('permission:set', s, body, (input, actor) =>
      this.members.setPermissions(actor, input),
    );
  }

  @SubscribeMessage('member:kick')
  kick(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('member:kick', s, body, (input, actor) =>
      this.members.kick(actor, input.memberId),
    );
  }

  @SubscribeMessage('room:settings')
  settings(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('room:settings', s, body, (input, actor) =>
      this.members.updateSettings(actor, input),
    );
  }

  // ------------------------------------------------------------ library (A1) & favourites (A2)

  // ------------------------------------------------------------ accounts (L1, L6)

  private requireUser(s: AppSocket): string {
    if (!s.data.userId) throw new AppError('UNAUTHENTICATED');
    return s.data.userId;
  }

  @SubscribeMessage('auth:google')
  signIn(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('auth:google', s, body, async (input) => {
      this.limitIp(s);
      const { token, user } = await this.users.signIn(input.credential);
      s.data.userId = user.id;
      const b = s.data.bound;
      if (b) {
        await this.members.linkMember(b.memberId, user.id);
        await this.library.pushIds(b.memberId);
      }
      return { token, user: this.users.view(user) };
    });
  }

  @SubscribeMessage('auth:me')
  me(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('auth:me', s, body, async () => {
      const user = s.data.userId ? await this.users.byId(s.data.userId) : null;
      return { user: user ? this.users.view(user) : null };
    });
  }

  @SubscribeMessage('room:delete')
  deleteRoom(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('room:delete', s, body, (input, actor) =>
      this.roomDeletion.deleteByOwner(actor, input.code),
    );
  }

  @SubscribeMessage('me:room-delete')
  deleteMyRoom(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('me:room-delete', s, body, (input) =>
      this.roomDeletion.deleteByAccount(this.requireUser(s), input.code, s.id),
    );
  }

  @SubscribeMessage('me:rooms')
  myRooms(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('me:rooms', s, body, async () => ({
      rooms: await this.users.myRooms(this.requireUser(s)),
    }));
  }

  @SubscribeMessage('rooms:status')
  roomsStatus(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('rooms:status', s, body, async (input) => {
      this.limit(`peek:${s.data.ip}`, PEEK_LIMIT);
      return { rooms: await this.users.roomsStatus(input.codes) };
    });
  }

  @SubscribeMessage('me:favorites-import')
  importFavorites(
    @ConnectedSocket() s: AppSocket,
    @MessageBody() body: unknown,
  ) {
    return this.run('me:favorites-import', s, body, async (input) => {
      const userId = this.requireUser(s);
      this.limit(`import:${userId}`, LOOKUP_LIMIT);
      const imported = await this.users.importFavorites(userId, input.videoIds);
      if (s.data.bound) await this.library.pushIds(s.data.bound.memberId);
      return { imported };
    });
  }

  // ------------------------------------------------------------ playlists (L2)

  @SubscribeMessage('playlist:mine')
  playlistMine(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('playlist:mine', s, body, async (input) => ({
      playlists: await this.personal.mine(this.requireUser(s), input.trackId),
    }));
  }

  @SubscribeMessage('playlist:create')
  playlistCreate(
    @ConnectedSocket() s: AppSocket,
    @MessageBody() body: unknown,
  ) {
    return this.run('playlist:create', s, body, async (input) => {
      const userId = this.requireUser(s);
      this.limit(`playlist-write:${userId}`, PLAYLIST_WRITE_LIMIT);
      return {
        id: await this.personal.create(userId, input.name, input.trackIds),
      };
    });
  }

  @SubscribeMessage('playlist:update')
  playlistUpdate(
    @ConnectedSocket() s: AppSocket,
    @MessageBody() body: unknown,
  ) {
    return this.run('playlist:update', s, body, (input) =>
      this.personal.update(this.requireUser(s), input.id, input),
    );
  }

  @SubscribeMessage('playlist:delete')
  playlistDelete(
    @ConnectedSocket() s: AppSocket,
    @MessageBody() body: unknown,
  ) {
    return this.run('playlist:delete', s, body, (input) =>
      this.personal.remove(this.requireUser(s), input.id),
    );
  }

  @SubscribeMessage('playlist:set-track')
  playlistSetTrack(
    @ConnectedSocket() s: AppSocket,
    @MessageBody() body: unknown,
  ) {
    return this.run('playlist:set-track', s, body, (input) => {
      const userId = this.requireUser(s);
      this.limit(`playlist-write:${userId}`, PLAYLIST_WRITE_LIMIT);
      return this.personal.setTrack(
        userId,
        input.id,
        input.trackId,
        input.saved,
      );
    });
  }

  @SubscribeMessage('playlist:move')
  playlistMove(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('playlist:move', s, body, (input) =>
      this.personal.move(
        this.requireUser(s),
        input.id,
        input.trackId,
        input.to,
      ),
    );
  }

  @SubscribeMessage('playlist:get')
  playlistGet(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('playlist:get', s, body, (input) => {
      this.limit(`playlist-get:${s.data.ip}`, PEEK_LIMIT);
      return this.personal.get(s.data.userId, input);
    });
  }

  @SubscribeMessage('playlist:share')
  playlistShare(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('playlist:share', s, body, async (input) => ({
      shareCode: await this.personal.share(
        this.requireUser(s),
        input.id,
        input.enabled,
      ),
    }));
  }

  @SubscribeMessage('playlist:copy')
  playlistCopy(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('playlist:copy', s, body, async (input) => {
      const userId = this.requireUser(s);
      this.limit(`playlist-write:${userId}`, PLAYLIST_WRITE_LIMIT);
      return { id: await this.personal.copy(userId, input.shareCode) };
    });
  }

  // ------------------------------------------------------------ taste (L5)

  @SubscribeMessage('taste:for-me')
  tasteForMe(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('taste:for-me', s, body, async () => {
      const userId = this.requireUser(s);
      this.limit(`taste:${userId}`, LOOKUP_LIMIT);
      // In a room: leave out what is already queued there and what its rules refuse.
      const roomId = s.data.bound?.roomId;
      const room = roomId
        ? await this.prisma.room.findUnique({
            where: { id: roomId },
            select: { settings: true },
          })
        : null;
      return this.taste.forMe(
        userId,
        roomId && room
          ? { roomId, settings: readSettings(room.settings) }
          : null,
      );
    });
  }

  @SubscribeMessage('taste:save-mix')
  tasteSaveMix(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('taste:save-mix', s, body, () => {
      const userId = this.requireUser(s);
      this.limit(`playlist-write:${userId}`, PLAYLIST_WRITE_LIMIT);
      return this.taste.saveMix(userId);
    });
  }

  // ------------------------------------------------------------ YouTube import (L3)

  @SubscribeMessage('youtube:library')
  youtubeLibrary(
    @ConnectedSocket() s: AppSocket,
    @MessageBody() body: unknown,
  ) {
    return this.run('youtube:library', s, body, (input) => {
      const userId = this.requireUser(s);
      this.limit(`yt-import:${userId}`, YT_IMPORT_LIMIT);
      return this.youtubeAccount.library(userId, input.accessToken);
    });
  }

  @SubscribeMessage('youtube:import')
  youtubeImport(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('youtube:import', s, body, (input) => {
      const userId = this.requireUser(s);
      this.limit(`yt-import:${userId}`, YT_IMPORT_LIMIT);
      return this.youtubeAccount.import(
        userId,
        input.accessToken,
        input.source,
        input.musicOnly,
      );
    });
  }

  @SubscribeMessage('wish:suggest')
  suggestWish(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('wish:suggest', s, body, async (input, actor) => {
      await this.requireMember(actor);
      this.limit(`wish-ai:${actor.memberId}`, WISH_AI_LIMIT);
      let track: { title: string; artist: string | null; song: string | null };
      if (input.queueItemId) {
        // Only for my own waiting song, like editing its wish.
        const item = await this.prisma.queueItem.findFirst({
          where: { id: input.queueItemId, roomId: actor.roomId },
          select: {
            status: true,
            addedById: true,
            track: { select: { title: true, artist: true, song: true } },
          },
        });
        if (!item || item.status !== 'QUEUED') throw new AppError('STALE_ITEM');
        if (item.addedById !== actor.memberId) throw new AppError('FORBIDDEN');
        track = item.track;
      } else {
        // A song about to be added with a wish: its public title is all the AI gets.
        track = {
          title: input.title ?? '',
          artist: input.artist ?? null,
          song: null,
        };
      }
      return {
        text: await this.wishWriter.write(
          track,
          input.hint,
          input.language ?? 'vi',
        ),
      };
    });
  }

  @SubscribeMessage('room:recap')
  recap(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('room:recap', s, body, (input, actor) => {
      this.limit(`recap:${actor.memberId}`, RECAP_LIMIT);
      return this.library.recap(
        actor,
        input.since,
        input.tzOffsetMinutes,
        input.language ?? 'vi',
      );
    });
  }

  @SubscribeMessage('playlist:open')
  openPlaylist(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('playlist:open', s, body, async (input, actor) => {
      await this.requireMember(actor);
      this.limit(`playlist:${actor.memberId}`, LOOKUP_LIMIT);
      return this.playlists.open(input.url);
    });
  }

  @SubscribeMessage('songlist:match')
  matchSongList(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('songlist:match', s, body, async (input, actor) => {
      await this.requireMember(actor);
      this.limit(`songlist:${actor.memberId}`, SONGLIST_LIMIT);
      return this.songlist.match(actor.memberId, input.lines);
    });
  }

  /** N1: this socket plays the room on its own device (or stops). Shown as "🎧" to others. */
  @SubscribeMessage('listen:set')
  setListening(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('listen:set', s, body, async (input, actor) => {
      await this.requireMember(actor);
      this.limit(`listen:${actor.memberId}`, LISTEN_LIMIT);
      if (this.presence.setListening(s.id, input.on))
        await this.state.touch(actor.roomId);
      return {};
    });
  }

  @SubscribeMessage('listen:unplayable')
  listenUnplayable(
    @ConnectedSocket() s: AppSocket,
    @MessageBody() body: unknown,
  ) {
    return this.run('listen:unplayable', s, body, async (input, actor) => {
      await this.requireMember(actor);
      this.limit(`listen:${actor.memberId}`, LISTEN_LIMIT);
      await this.playback.listenerUnplayable(actor, input);
      return {};
    });
  }

  @SubscribeMessage('queue:add-many')
  addMany(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('queue:add-many', s, body, (input, actor) =>
      this.queue.addMany(actor, input.trackIds),
    );
  }

  @SubscribeMessage('lyrics:get')
  getLyrics(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('lyrics:get', s, body, async (input, actor) => {
      this.limit(`lyrics:${actor.memberId}`, LYRICS_LIMIT);
      return { lyrics: await this.lyrics.forTrack(input.trackId) };
    });
  }

  @SubscribeMessage('suggest:next')
  suggestNext(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('suggest:next', s, body, async (input, actor) => {
      this.limit(`suggest:${actor.memberId}`, LOOKUP_LIMIT);
      const room = await this.prisma.room.findUniqueOrThrow({
        where: { id: actor.roomId },
        select: { settings: true },
      });
      return {
        items: await this.suggest.forRoom(
          actor.roomId,
          input.trackId ?? null,
          readSettings(room.settings),
        ),
      };
    });
  }

  @SubscribeMessage('library:room')
  roomLibrary(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('library:room', s, body, (input, actor) =>
      this.library.roomLibrary(actor, input.sort),
    );
  }

  @SubscribeMessage('track:block')
  blockTrack(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('track:block', s, body, (input, actor) =>
      this.blocks.block(actor, input.trackId),
    );
  }

  @SubscribeMessage('track:unblock')
  unblockTrack(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('track:unblock', s, body, (input, actor) =>
      this.blocks.unblock(actor, input.trackId),
    );
  }

  @SubscribeMessage('track:blocked')
  blockedTracks(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('track:blocked', s, body, (_input, actor) =>
      this.blocks.list(actor),
    );
  }

  @SubscribeMessage('favorite:set')
  setFavorite(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('favorite:set', s, body, (input, actor) =>
      this.library.setFavorite(actor, input.trackId, input.saved),
    );
  }

  @SubscribeMessage('favorite:list')
  listFavorites(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('favorite:list', s, body, (_i, actor) =>
      this.library.listFavorites(actor),
    );
  }

  @SubscribeMessage('tracks:lookup')
  lookup(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('tracks:lookup', s, body, (input, actor) => {
      this.limit(`lookup:${actor.memberId}`, LOOKUP_LIMIT);
      return this.library.lookup(input.videoIds);
    });
  }

  // ------------------------------------------------------------ queue

  @SubscribeMessage('queue:add')
  add(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('queue:add', s, body, (input, actor) =>
      this.queue.add(actor, input, { upvote: true }),
    );
  }

  @SubscribeMessage('queue:remove')
  remove(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('queue:remove', s, body, (input, actor) =>
      this.queue.remove(actor, input.queueItemId),
    );
  }

  @SubscribeMessage('queue:pin-next')
  pin(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('queue:pin-next', s, body, (input, actor) =>
      this.queue.pinNext(actor, input.queueItemId),
    );
  }

  @SubscribeMessage('queue:heart')
  heart(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('queue:heart', s, body, (input, actor) =>
      this.queue.heart(actor, input.queueItemId),
    );
  }

  @SubscribeMessage('queue:set-message')
  setMessage(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('queue:set-message', s, body, (input, actor) => {
      this.limit(`wish:${actor.memberId}`, WISH_LIMIT);
      return this.queue.setMessage(actor, input);
    });
  }

  @SubscribeMessage('queue:vote-skip')
  voteSkip(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('queue:vote-skip', s, body, (input, actor) => {
      this.limit(`vote:${actor.memberId}`, VOTE_LIMIT);
      return this.playback.voteSkip(actor, input.queueItemId, input.approve);
    });
  }

  @SubscribeMessage('search:query')
  searchQuery(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('search:query', s, body, async (input, actor) => {
      await this.requireMember(actor);
      return this.search.search(
        actor.memberId,
        input.q,
        input.remote,
        input.page ?? 0,
      );
    });
  }

  // ------------------------------------------------------------ playback

  @SubscribeMessage('playback:control')
  control(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('playback:control', s, body, (input, actor) =>
      this.playback.control(actor, input),
    );
  }

  @SubscribeMessage('player:claim')
  claimPlayer(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('player:claim', s, body, (_i, actor) =>
      this.playback.claimPlayer(actor),
    );
  }

  @SubscribeMessage('player:heartbeat')
  heartbeat(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('player:heartbeat', s, body, (_i, actor) =>
      this.playback.heartbeat(actor),
    );
  }

  @SubscribeMessage('player:report')
  report(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('player:report', s, body, (input, actor) =>
      this.playback.report(actor, input),
    );
  }

  // ------------------------------------------------------------ social

  @SubscribeMessage('chat:send')
  chat(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('chat:send', s, body, async (input, actor) => {
      const saved = await this.social.chat(actor, input.content);
      // "@DJ": answered in the background, as a chat message of its own.
      this.djBrain.onRoomChat(actor, saved);
    });
  }

  @SubscribeMessage('room:reaction')
  reaction(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('room:reaction', s, body, (input, actor) =>
      this.social.reaction(actor, input.emoji),
    );
  }

  @SubscribeMessage('dj:trigger')
  dj(@ConnectedSocket() s: AppSocket, @MessageBody() body: unknown) {
    return this.run('dj:trigger', s, body, (input, actor) =>
      this.social.dj(actor, input.soundType),
    );
  }
}
