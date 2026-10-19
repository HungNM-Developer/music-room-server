import { Injectable, Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { AppError } from '../common/app-error';
import {
  type CommandInput,
  DEFAULT_SETTINGS,
  nameKey,
  type RoomSettings,
} from '../contracts';
import { Prisma, type Member } from '../generated/prisma/client';
import { PlaylistService } from '../music/playlist.service';
import { PlaybackService } from '../playback/playback.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { Broadcaster } from '../realtime/broadcaster.service';
import { PresenceService } from '../realtime/presence.service';
import { generateRoomCode } from '../rooms/room-code';
import { ActivityService } from '../social/activity.service';
import {
  type Actor,
  type MutateCtx,
  RoomStateService,
} from '../state/room-state.service';
import { readSettings } from '../state/settings';

const COLORS = [
  '#FF5733',
  '#33C1FF',
  '#3357FF',
  '#B833FF',
  '#22C55E',
  '#FFC300',
  '#14B8A6',
  '#C70039',
  '#F97316',
  '#EC4899',
];
const DEVICE_NAME = 'Máy phát';

export interface Session {
  token: string;
  code: string;
  memberId: string;
  roomId: string;
}

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly state: RoomStateService,
    private readonly playback: PlaybackService,
    private readonly queue: QueueService,
    private readonly activity: ActivityService,
    private readonly broadcaster: Broadcaster,
    private readonly playlists: PlaylistService,
    private readonly presence: PresenceService,
  ) {}

  private color(): string {
    return COLORS[Math.floor(Math.random() * COLORS.length)];
  }

  private session(m: Member, code: string): Session {
    return {
      token: this.auth.sign(m.id, m.roomId, m.tokenVersion),
      code,
      memberId: m.id,
      roomId: m.roomId,
    };
  }

  private async roomByCode(code: string) {
    const room = await this.prisma.room.findUnique({ where: { code } });
    if (!room) throw new AppError('ROOM_NOT_FOUND');
    return room;
  }

  // ------------------------------------------------------------ create / join

  async create(
    input: CommandInput<'room:create'>,
    userId?: string,
  ): Promise<Session> {
    const adminPinHash = await this.auth.hashPin(input.adminPin);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateRoomCode();
      try {
        const member = await this.prisma.$transaction(async (tx) => {
          const room = await tx.room.create({
            data: {
              code,
              name: input.name,
              settings: DEFAULT_SETTINGS,
              adminPinHash,
              // L6: a signed-in creator owns the room.
              ownerId: userId ?? null,
              playback: { create: {} },
            },
          });
          const m = await tx.member.create({
            data: {
              roomId: room.id,
              displayName: input.displayName,
              displayNameKey: nameKey(input.displayName),
              color: this.color(),
              role: 'ADMIN',
              // L1: the signed-in creator's member belongs to their account.
              userId: userId ?? null,
              // Kept from v1: the creator's device plays until a /host page takes over.
              canPlay: true,
              canControl: true,
              canDj: true,
            },
          });
          await tx.activityLog.create({
            data: {
              roomId: room.id,
              memberId: m.id,
              displayName: m.displayName,
              type: 'room_create',
              message: 'đã tạo phòng',
              metadata: { v: 1 },
            },
          });
          return m;
        });
        return this.session(member, code);
      } catch (e) {
        if (isUniqueViolation(e)) continue; // TC-009: code collision → retry
        throw e;
      }
    }
    this.logger.error('Could not allocate a unique room code after 5 attempts');
    throw new AppError('INTERNAL');
  }

  async peek(code: string) {
    const room = await this.roomByCode(code);
    const memberCount = await this.prisma.member.count({
      where: { roomId: room.id, leftAt: null, kickedAt: null, isDevice: false },
    });
    const online = this.presence.onlineMembers(room.id).size;
    return {
      name: room.name,
      memberCount,
      onlineCount: online,
      theme: readSettings(room.settings).theme,
    };
  }

  /**
   * A new name creates a member. A name held by an *offline* member brings that member
   * back (same colour, songs, hearts, rights) — the way back for someone whose browser
   * lost its token. An offline admin needs the room PIN; online members and player
   * devices keep their names (NAME_TAKEN).
   */
  async join(
    input: CommandInput<'room:join'>,
    ip: string,
    userId?: string,
  ): Promise<Session & { rejoined: boolean; rightsReset: boolean }> {
    const room = await this.roomByCode(input.code);
    if (userId) return this.joinWithAccount(room, input.displayName, userId);
    const displayName = input.displayName;
    if (!displayName) throw new AppError('VALIDATION');
    const holder = await this.prisma.member.findFirst({
      where: {
        roomId: room.id,
        displayNameKey: nameKey(displayName),
        leftAt: null,
        kickedAt: null,
      },
    });
    if (holder) {
      const { session, rightsReset } = await this.rejoin(
        room,
        holder,
        input.adminPin,
        ip,
      );
      return { ...session, rejoined: true, rightsReset };
    }
    const settings = readSettings(room.settings);
    try {
      const member = await this.state.mutate(room.id, async (tx, ctx) => {
        const m = await tx.member.create({
          data: {
            roomId: room.id,
            displayName,
            displayNameKey: nameKey(displayName),
            color: this.color(),
            canDj: settings.allowGuestDj,
          },
        });
        await this.activity.log(
          tx,
          ctx,
          room.id,
          m,
          'user_join',
          'đã vào phòng',
          { variant: 'join' },
        );
        return m;
      });
      return {
        ...this.session(member, room.code),
        rejoined: false,
        rightsReset: false,
      };
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('NAME_TAKEN');
      throw e;
    }
  }

  /**
   * A name is no credential: a non-admin coming back by name keeps their name, colour,
   * songs and hearts, but control / DJ / player rights go back to what a new member
   * gets — an admin grants them again, or the PIN (admin:claim) restores everything.
   * An admin proves themselves with the PIN and keeps everything.
   */
  private async rejoin(
    room: {
      id: string;
      code: string;
      adminPinHash: string | null;
      settings: Prisma.JsonValue;
    },
    holder: Member,
    pin: string | undefined,
    ip: string,
  ): Promise<{ session: Session; rightsReset: boolean }> {
    // A member tied to a Google account comes back only through that account (L1).
    if (
      holder.isDevice ||
      holder.userId ||
      this.presence.onlineMembers(room.id).has(holder.id)
    )
      throw new AppError('NAME_TAKEN');
    if (holder.role === 'ADMIN') {
      if (!room.adminPinHash) throw new AppError('PIN_NOT_SET');
      if (!pin) throw new AppError('PIN_REQUIRED');
      await this.auth.checkPin(room.adminPinHash, pin, `${ip}|${room.id}`);
    }
    const member = await this.state.mutate(room.id, async (tx, ctx) => {
      const m = await tx.member.findUnique({ where: { id: holder.id } });
      // Left or was kicked in the meantime: the name is free now, so just try again.
      if (!m || m.leftAt || m.kickedAt) throw new AppError('STALE_ITEM');
      const guestDj = readSettings(room.settings).allowGuestDj;
      const reset =
        m.role !== 'ADMIN' &&
        (m.canControl || m.canPlay || m.canDj !== guestDj);
      if (reset) {
        await tx.member.update({
          where: { id: m.id },
          data: { canControl: false, canPlay: false, canDj: guestDj },
        });
        const ps = await tx.playbackState.findUniqueOrThrow({
          where: { roomId: room.id },
        });
        if (ps.playerMemberId === m.id) {
          await tx.playbackState.update({
            where: { roomId: room.id },
            data: { playerMemberId: null },
          });
          ctx.afterCommit(() =>
            this.playback.releasePlayer(room.id, m.id, 'permission'),
          );
        }
      }
      await this.activity.log(
        tx,
        ctx,
        room.id,
        m,
        'user_rejoin',
        reset
          ? 'đã quay lại phòng (quyền điều khiển, DJ, máy phát cần được cấp lại)'
          : 'đã quay lại phòng',
        { variant: reset ? 'rightsReset' : 'plain' },
      );
      return { m, reset };
    });
    // tokenVersion is left alone: the old browser, if it ever comes back, still works.
    return {
      session: this.session(member.m, room.code),
      rightsReset: member.reset,
    };
  }

  // ------------------------------------------------------------ accounts (L1, L6)

  /**
   * Signed in: the account's member in this room, on any device and with all its
   * rights (the account is the proof); otherwise a new member with the given or Google
   * name (" 2", " 3"… when taken). The owner is always admin (L6).
   */
  private async joinWithAccount(
    room: {
      id: string;
      code: string;
      ownerId: string | null;
      settings: Prisma.JsonValue;
    },
    wantedName: string | undefined,
    userId: string,
  ): Promise<Session & { rejoined: boolean; rightsReset: boolean }> {
    const owner = room.ownerId === userId;
    const mine = await this.prisma.member.findFirst({
      where: {
        roomId: room.id,
        userId,
        leftAt: null,
        kickedAt: null,
        isDevice: false,
      },
    });
    if (mine) {
      const member = await this.state.mutate(room.id, async (tx, ctx) => {
        const m =
          owner && mine.role !== 'ADMIN'
            ? await tx.member.update({
                where: { id: mine.id },
                data: { role: 'ADMIN', canControl: true, canDj: true },
              })
            : mine;
        await this.activity.log(
          tx,
          ctx,
          room.id,
          m,
          'user_rejoin',
          'đã quay lại phòng',
          { variant: 'plain' },
        );
        return m;
      });
      return {
        ...this.session(member, room.code),
        rejoined: true,
        rightsReset: false,
      };
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const base = (wantedName ?? user.name).slice(0, 30);
    const settings = readSettings(room.settings);
    for (let n = 1; n <= 20; n++) {
      const name = n === 1 ? base : `${base.slice(0, 27)} ${n}`;
      try {
        const member = await this.state.mutate(room.id, async (tx, ctx) => {
          const m = await tx.member.create({
            data: {
              roomId: room.id,
              displayName: name,
              displayNameKey: nameKey(name),
              color: this.color(),
              userId,
              ...(owner
                ? { role: 'ADMIN' as const, canControl: true, canDj: true }
                : { canDj: settings.allowGuestDj }),
            },
          });
          await this.activity.log(
            tx,
            ctx,
            room.id,
            m,
            'user_join',
            'đã vào phòng',
            { variant: 'join' },
          );
          return m;
        });
        return {
          ...this.session(member, room.code),
          rejoined: false,
          rightsReset: false,
        };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    throw new AppError('NAME_TAKEN');
  }

  /**
   * Ties a guest member to the account signed in on its socket, unless the account
   * already has another member in that room. Saved songs move to the account; the
   * room's creator becomes its owner when the room has none yet.
   */
  async linkMember(memberId: string, userId: string): Promise<void> {
    const m = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!m || m.userId || m.isDevice || m.leftAt || m.kickedAt) return;
    await this.state.mutate(m.roomId, async (tx) => {
      const other = await tx.member.findFirst({
        where: {
          roomId: m.roomId,
          userId,
          leftAt: null,
          kickedAt: null,
          id: { not: m.id },
        },
      });
      if (other) return;
      await tx.member.update({ where: { id: m.id }, data: { userId } });
      const favs = await tx.favorite.findMany({ where: { memberId: m.id } });
      if (favs.length) {
        await tx.userFavorite.createMany({
          data: favs.map((f) => ({
            userId,
            trackId: f.trackId,
            createdAt: f.createdAt,
          })),
          skipDuplicates: true,
        });
        await tx.favorite.deleteMany({ where: { memberId: m.id } });
      }
      const room = await tx.room.findUniqueOrThrow({ where: { id: m.roomId } });
      if (!room.ownerId) {
        const created = await tx.activityLog.findFirst({
          where: { roomId: m.roomId, type: 'room_create', memberId: m.id },
        });
        if (created)
          await tx.room.update({
            where: { id: room.id },
            data: { ownerId: userId },
          });
      }
    });
  }

  /** Token → member, only if still active and the token version matches (R-06, R-10, R-11). */
  async resume(
    token: unknown,
  ): Promise<{ member: Member; code: string } | null> {
    const claims = this.auth.verify(token);
    if (!claims) return null;
    const member = await this.prisma.member.findUnique({
      where: { id: claims.sub },
      include: { room: { select: { code: true } } },
    });
    if (
      !member ||
      member.roomId !== claims.rid ||
      member.tokenVersion !== claims.tv ||
      member.leftAt ||
      member.kickedAt
    ) {
      return null;
    }
    const { room, ...m } = member;
    await this.prisma.member.update({
      where: { id: m.id },
      data: { lastSeenAt: new Date() },
    });
    return { member: m, code: room.code };
  }

  // ------------------------------------------------------------ leave / kick

  /** Shared by leave (R-11) and kick (R-10): frees the name, kills tokens, drops hearts/votes. */
  private async deactivate(
    tx: Tx,
    roomId: string,
    m: Member,
    kicked: boolean,
    now: Date,
  ) {
    await tx.member.update({
      where: { id: m.id },
      data: {
        displayNameKey: null,
        tokenVersion: { increment: 1 },
        canPlay: false,
        ...(kicked ? { kickedAt: now } : { leftAt: now }),
      },
    });
    await tx.heart.deleteMany({
      where: { memberId: m.id, queueItem: { roomId, status: 'QUEUED' } },
    });
    await tx.skipVote.deleteMany({
      where: { memberId: m.id, queueItem: { roomId, status: 'PLAYING' } },
    });
    const ps = await tx.playbackState.findUniqueOrThrow({ where: { roomId } });
    if (ps.playerMemberId === m.id) {
      await tx.playbackState.update({
        where: { roomId },
        data: { playerMemberId: null },
      });
    }
  }

  async leave(actor: Actor): Promise<void> {
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.state.activeMember(tx, actor);
      await this.deactivate(tx, actor.roomId, me, false, ctx.now);
      await this.activity.log(
        tx,
        ctx,
        actor.roomId,
        me,
        'user_leave',
        'đã rời phòng',
      );
      await this.playback.reevaluateSkip(tx, ctx, actor.roomId);
      ctx.afterCommit(() => {
        this.playback.releasePlayer(actor.roomId, me.id, 'permission');
        this.broadcaster.revokeMember(me.id, 'left');
      });
    });
  }

  async kick(actor: Actor, targetId: string): Promise<void> {
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.requireAdmin(tx, actor);
      if (targetId === me.id) throw new AppError('FORBIDDEN');
      const target = await this.activeTarget(tx, actor.roomId, targetId);
      await this.deactivate(tx, actor.roomId, target, true, ctx.now);
      await this.queue.removeAllOf(tx, actor.roomId, target);
      await this.activity.log(
        tx,
        ctx,
        actor.roomId,
        me,
        'member_kick',
        `đã mời ${target.displayName} ra khỏi phòng`,
        {
          target: target.displayName,
          targetDevice: target.isDevice || undefined,
        },
      );
      await this.playback.reevaluateSkip(tx, ctx, actor.roomId);
      ctx.afterCommit(() => {
        this.playback.releasePlayer(actor.roomId, target.id, 'kicked');
        this.broadcaster.revokeMember(target.id, 'kicked');
      });
    });
  }

  // ------------------------------------------------------------ admin

  private async requireAdmin(tx: Tx, actor: Actor): Promise<Member> {
    const me = await this.state.activeMember(tx, actor);
    if (me.role !== 'ADMIN') throw new AppError('FORBIDDEN');
    return me;
  }

  private async activeTarget(
    tx: Tx,
    roomId: string,
    id: string,
  ): Promise<Member> {
    const t = await tx.member.findUnique({ where: { id } });
    if (!t || t.roomId !== roomId || t.leftAt || t.kickedAt)
      throw new AppError('STALE_ITEM');
    return t;
  }

  /** Any member (not a player device) who knows the room PIN becomes admin. */
  async claimAdmin(actor: Actor, pin: string, ip: string): Promise<void> {
    const room = await this.prisma.room.findUniqueOrThrow({
      where: { id: actor.roomId },
    });
    const member = await this.prisma.member.findUnique({
      where: { id: actor.memberId },
    });
    if (member?.isDevice) throw new AppError('FORBIDDEN');
    if (member?.role === 'ADMIN') return;
    await this.auth.checkPin(room.adminPinHash, pin, `${ip}|${room.id}`);
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.state.activeMember(tx, actor);
      await tx.member.update({
        where: { id: me.id },
        data: { role: 'ADMIN', canControl: true, canDj: true },
      });
      await this.activity.log(
        tx,
        ctx,
        actor.roomId,
        me,
        'admin_claim',
        'đã nhận quyền quản trị bằng mã PIN',
      );
    });
  }

  /**
   * A room nobody owns (its creator never signed in, or is gone): a signed-in admin keeps it,
   * so it is never deleted as unused. The member is tied to the account first (as signing in
   * would); a room that already has an owner stays theirs.
   */
  async claimOwner(actor: Actor, userId: string): Promise<void> {
    await this.linkMember(actor.memberId, userId);
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.requireAdmin(tx, actor);
      if (me.isDevice || (me.userId && me.userId !== userId))
        throw new AppError('FORBIDDEN');
      const room = await tx.room.findUniqueOrThrow({
        where: { id: actor.roomId },
      });
      // The creator's sign-in (linkMember) may have just made them the owner.
      if (room.ownerId === userId) return;
      if (room.ownerId) throw new AppError('FORBIDDEN');
      await tx.room.update({
        where: { id: room.id },
        data: { ownerId: userId },
      });
      await this.activity.log(
        tx,
        ctx,
        actor.roomId,
        me,
        'owner_claim',
        'đã nhận giữ phòng',
      );
    });
  }

  /** Admin only: set the PIN (rooms from before PINs) or change it. */
  async setPin(actor: Actor, pin: string): Promise<void> {
    const adminPinHash = await this.auth.hashPin(pin);
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.requireAdmin(tx, actor);
      await tx.room.update({
        where: { id: actor.roomId },
        data: { adminPinHash },
      });
      await this.activity.log(
        tx,
        ctx,
        actor.roomId,
        me,
        'pin_change',
        'đã đổi mã PIN quản trị',
      );
    });
  }

  /** R-13 / R-14 */
  async setPermissions(
    actor: Actor,
    input: CommandInput<'permission:set'>,
  ): Promise<void> {
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.requireAdmin(tx, actor);
      const target = await this.activeTarget(tx, actor.roomId, input.memberId);
      if (target.id === me.id && input.role === 'USER')
        throw new AppError('FORBIDDEN');
      if (target.isDevice && input.role === 'ADMIN')
        throw new AppError('FORBIDDEN');

      const data: Prisma.MemberUpdateInput = {};
      const changes: { message: string; variant: string }[] = [];
      const name = target.displayName;
      const flag = (
        on: boolean,
        grant: string,
        revoke: string,
        variants: [grant: string, revoke: string],
      ) =>
        changes.push({
          message: (on ? grant : revoke).replace('{n}', name),
          variant: on ? variants[0] : variants[1],
        });

      if (
        input.canControl !== undefined &&
        input.canControl !== target.canControl
      ) {
        data.canControl = input.canControl;
        flag(
          input.canControl,
          'đã cấp quyền điều khiển cho {n}',
          'đã bỏ quyền điều khiển của {n}',
          ['grantControl', 'revokeControl'],
        );
      }
      if (input.canDj !== undefined && input.canDj !== target.canDj) {
        data.canDj = input.canDj;
        flag(input.canDj, 'đã cấp quyền DJ cho {n}', 'đã bỏ quyền DJ của {n}', [
          'grantDj',
          'revokeDj',
        ]);
      }
      if (input.role !== undefined && input.role !== target.role) {
        data.role = input.role;
        if (input.role === 'ADMIN') {
          data.canControl = true;
          data.canDj = true;
        }
        flag(
          input.role === 'ADMIN',
          'đã cấp quyền quản trị cho {n}',
          'đã bỏ quyền quản trị của {n}',
          ['grantAdmin', 'revokeAdmin'],
        );
      }
      let revokePlayerOf: string | null = null;
      if (input.canPlay !== undefined && input.canPlay !== target.canPlay) {
        data.canPlay = input.canPlay;
        if (input.canPlay) {
          // R-14: exactly one canPlay; current lease holder (if another member) loses it.
          await tx.member.updateMany({
            where: {
              roomId: actor.roomId,
              id: { not: target.id },
              canPlay: true,
            },
            data: { canPlay: false },
          });
          const holder = await tx.playbackState.findUniqueOrThrow({
            where: { roomId: actor.roomId },
          });
          if (holder.playerMemberId && holder.playerMemberId !== target.id) {
            revokePlayerOf = holder.playerMemberId;
          }
          flag(true, 'đã đặt {n} làm máy phát', '', ['makePlayer', '']);
        } else {
          revokePlayerOf = target.id;
          changes.push({
            message: `đã bỏ quyền máy phát của ${name}`,
            variant: 'revokePlayer',
          });
        }
      }
      if (Object.keys(data).length === 0) return;
      await tx.member.update({ where: { id: target.id }, data });
      for (const c of changes) {
        await this.activity.log(
          tx,
          ctx,
          actor.roomId,
          me,
          'permission_change',
          c.message,
          {
            variant: c.variant,
            target: name,
            targetDevice: target.isDevice || undefined,
          },
        );
      }
      if (revokePlayerOf) {
        const id = revokePlayerOf;
        await tx.playbackState.updateMany({
          where: { roomId: actor.roomId, playerMemberId: id },
          data: { playerMemberId: null },
        });
        ctx.afterCommit(() =>
          this.playback.releasePlayer(actor.roomId, id, 'permission'),
        );
      }
    });
  }

  async updateSettings(
    actor: Actor,
    patch: CommandInput<'room:settings'>,
  ): Promise<void> {
    let playlistToLoad: string | null = null;
    await this.state.mutate(actor.roomId, async (tx, ctx) => {
      const me = await this.requireAdmin(tx, actor);
      const room = await tx.room.findUniqueOrThrow({
        where: { id: actor.roomId },
      });
      const current = readSettings(room.settings);
      const next: RoomSettings = { ...current, ...patch };
      await tx.room.update({
        where: { id: room.id },
        data: { settings: next },
      });
      await this.activity.log(
        tx,
        ctx,
        actor.roomId,
        me,
        'settings_change',
        Object.keys(patch).every((k) => k === 'theme')
          ? 'đã đổi giao diện phòng'
          : 'đã thay đổi cài đặt phòng',
        {
          variant: Object.keys(patch).every((k) => k === 'theme')
            ? 'theme'
            : 'other',
        },
      );
      await this.playback.reevaluateSkip(tx, ctx, actor.roomId);
      // Radio just switched on in a silent room: start it now (A4).
      if (next.autoRadio && !current.autoRadio)
        await this.playback.startIfIdle(tx, ctx, actor.roomId);
      if (
        next.fallbackPlaylistUrl &&
        next.fallbackPlaylistUrl !== current.fallbackPlaylistUrl
      ) {
        playlistToLoad = next.fallbackPlaylistUrl;
      }
    });
    if (playlistToLoad) void this.loadFallback(actor.roomId, playlistToLoad);
  }

  /** Resolves the fallback playlist in the background, then starts playback if idle. */
  private async loadFallback(roomId: string, url: string): Promise<void> {
    try {
      const ids = await this.playlists.refresh(url);
      if (ids.length === 0) return;
      await this.state.mutate(roomId, (tx, ctx: MutateCtx) =>
        this.playback.startIfIdle(tx, ctx, roomId),
      );
    } catch (e) {
      this.logger.warn(`Fallback playlist load failed: ${String(e)}`);
    }
  }

  // ------------------------------------------------------------ host device

  /** /r/CODE/host: a device member (isDevice) that may claim the lease (R-27). No PIN. */
  async registerHost(input: CommandInput<'host:register'>): Promise<Session> {
    const room = await this.roomByCode(input.code);
    const member = await this.state.mutate(room.id, async (tx, ctx) => {
      // Offline devices from earlier sessions are retired so the member list stays clean.
      const old = await tx.member.findMany({
        where: {
          roomId: room.id,
          isDevice: true,
          leftAt: null,
          kickedAt: null,
        },
      });
      const online = this.presence.onlineMembers(room.id);
      for (const d of old.filter((x) => !online.has(x.id))) {
        await this.deactivate(tx, room.id, d, false, ctx.now);
      }
      // Any active member may already use the name (e.g. a person called "Máy phát").
      const active = await tx.member.findMany({
        where: { roomId: room.id, leftAt: null, kickedAt: null },
        select: { displayNameKey: true },
      });
      const taken = new Set(active.map((m) => m.displayNameKey));
      let name = DEVICE_NAME;
      for (let n = 2; taken.has(nameKey(name)); n++)
        name = `${DEVICE_NAME} ${n}`;
      const m = await tx.member.create({
        data: {
          roomId: room.id,
          displayName: name,
          displayNameKey: nameKey(name),
          color: '#64748B',
          isDevice: true,
        },
      });
      await this.activity.log(tx, ctx, room.id, m, 'user_join', 'đã kết nối', {
        variant: 'device',
      });
      return m;
    });
    return this.session(member, room.code);
  }
}
