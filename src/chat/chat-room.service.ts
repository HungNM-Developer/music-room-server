import { Inject, Injectable } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { AppError } from '../common/app-error';
import { ENV, type Env } from '../config/env';
import {
  cleanLine,
  nameKey,
  normalizeRoomCode,
  type QueueItemView,
  type Reaction,
  type TrackSummary,
} from '../contracts';
import type { ChatLink, Member } from '../generated/prisma/client';
import { SearchService } from '../music/search.service';
import { PlaybackService } from '../playback/playback.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { PresenceService } from '../realtime/presence.service';
import { ActivityService } from '../social/activity.service';
import { SocialService } from '../social/social.service';
import type { Actor } from '../state/room-state.service';
import { RoomActivityService } from '../rooms/room-activity.service';
import { RoomStateService } from '../state/room-state.service';
import { readSettings } from '../state/settings';
import { SnapshotService } from '../state/snapshot.service';

export type ChatPlatformName = 'slack';

/** Who wrote in the chat app, as that app reports it. */
export interface ChatUser {
  platform: ChatPlatformName;
  teamId: string;
  userId: string;
  /** Name to use: the chat app's display name, else its handle; '' when unknown. */
  name: string;
  /** The display name from the person's profile; '' when the app did not give it. */
  profileName: string;
  email: string | null;
  /** The profile picture; null / absent when the app did not give one. */
  avatarUrl?: string | null;
}

/** Shown while the chat app hides the person's name. */
export const CHAT_PLACEHOLDER_NAME = 'Người dùng Slack';
/** A raw Slack user id ("U0956R22J11"), used as a name by an earlier version. */
const SLACK_ID = /^[UW][A-Z0-9]{8,}$/;
const isPlaceholder = (name: string) =>
  SLACK_ID.test(name) || name.startsWith(CHAT_PLACEHOLDER_NAME);

export interface NowView {
  roomName: string;
  roomCode: string;
  roomUrl: string;
  playing: {
    itemId: string;
    title: string;
    thumbnailUrl: string | null;
    pickedBy: string | null;
    paused: boolean;
    positionSec: number;
    durationSec: number | null;
  } | null;
  next: { title: string; pickedBy: string | null }[];
}

/** A song as the Slack Home tab shows it. */
export interface HomeTrack {
  title: string;
  /** Parsed from the title (AI1); null until known. */
  artist: string | null;
  song: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  pickedBy: string | null;
  /** The room picked it itself (radio / fallback playlist). */
  auto: 'radio' | 'fallback' | null;
  hearts: number;
}

/** Everything the Slack Home tab shows about one room, at `at` (epoch ms). */
export interface HomeView {
  at: number;
  roomId: string;
  roomName: string;
  roomCode: string;
  roomUrl: string;
  /** Names of the people in the room right now (not the speaker device). */
  present: string[];
  listening: number;
  playing:
    | (HomeTrack & {
        itemId: string;
        paused: boolean;
        positionSec: number;
      })
    | null;
  /** The open skip vote (V1). */
  vote: {
    openedBy: string | null;
    votes: number;
    required: number;
    against: number;
    endsAt: number;
  } | null;
  /** After a vote kept the song: no new vote before this (epoch ms). */
  blockedUntil: number | null;
  next: HomeTrack[];
  queueLength: number;
}

const MEMBER_COLORS = [
  '#f6a623',
  '#5fd39a',
  '#7cc4ff',
  '#ff9a8e',
  '#c9a7ff',
  '#ffd166',
];
/** A chat voter stays counted a little past the deadline, so the last tally includes them. */
const VOTER_GRACE_MS = 5_000;

/**
 * Đợt 3: what chat apps (Slack first) can do in a room. Platform adapters translate their
 * commands and buttons into these calls; the rules are the room's own (queue limits, the
 * V1 skip vote, rate limits) because every call goes through the same services as the web.
 */
@Injectable()
export class ChatRoomService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly state: RoomStateService,
    private readonly snapshots: SnapshotService,
    private readonly queue: QueueService,
    private readonly search: SearchService,
    private readonly playback: PlaybackService,
    private readonly social: SocialService,
    private readonly presence: PresenceService,
    private readonly activity: ActivityService,
    private readonly roomActivity: RoomActivityService,
  ) {}

  // ------------------------------------------------------------ channel ↔ room

  link(platform: ChatPlatformName, teamId: string, channelId: string) {
    return this.prisma.chatLink.findUnique({
      where: { platform_teamId_channelId: { platform, teamId, channelId } },
      include: { room: { select: { id: true, code: true, name: true } } },
    });
  }

  /** The rooms linked to any channel of a workspace, most recently linked first. */
  async roomsOfTeam(
    platform: ChatPlatformName,
    teamId: string,
  ): Promise<{ id: string; code: string; name: string }[]> {
    const links = await this.prisma.chatLink.findMany({
      where: { platform, teamId },
      orderBy: { createdAt: 'desc' },
      include: { room: { select: { id: true, code: true, name: true } } },
    });
    const rooms = new Map<string, { id: string; code: string; name: string }>();
    for (const l of links)
      if (!rooms.has(l.room.id)) rooms.set(l.room.id, l.room);
    return [...rooms.values()];
  }

  linksOfRoom(roomId: string): Promise<ChatLink[]> {
    return this.prisma.chatLink.findMany({ where: { roomId } });
  }

  /**
   * Admin PIN required; the same lockout as the web (per workspace and room). Only from
   * places where the PIN stays private (Slack: the slash command). Votes go to the channel
   * until someone picks a thread (`setThread`).
   */
  async connect(
    platform: ChatPlatformName,
    teamId: string,
    channelId: string,
    code: string,
    pin: string,
  ): Promise<{ name: string; code: string }> {
    const room = await this.prisma.room.findUnique({
      where: { code: normalizeRoomCode(code) },
    });
    if (!room) throw new AppError('ROOM_NOT_FOUND');
    await this.auth.checkPin(
      room.adminPinHash,
      pin,
      `${platform}|${teamId}|${room.id}`,
    );
    await this.prisma.chatLink.upsert({
      where: { platform_teamId_channelId: { platform, teamId, channelId } },
      create: { platform, teamId, channelId, roomId: room.id },
      // createdAt = when it was linked: Home opens the most recently linked room first.
      update: { roomId: room.id, threadTs: null, createdAt: new Date() },
    });
    this.roomActivity.touch(room.id);
    return { name: room.name, code: room.code };
  }

  /** Where an already linked channel's vote cards go: a thread of it, or the channel (null). */
  async setThread(
    platform: ChatPlatformName,
    teamId: string,
    channelId: string,
    threadTs: string | null,
  ): Promise<void> {
    const link = await this.prisma.chatLink.update({
      where: { platform_teamId_channelId: { platform, teamId, channelId } },
      data: { threadTs },
    });
    this.roomActivity.touch(link.roomId);
  }

  async disconnect(
    platform: ChatPlatformName,
    teamId: string,
    channelId: string,
    pin: string,
  ): Promise<void> {
    const link = await this.link(platform, teamId, channelId);
    if (!link) return;
    const room = await this.prisma.room.findUniqueOrThrow({
      where: { id: link.roomId },
    });
    await this.auth.checkPin(
      room.adminPinHash,
      pin,
      `${platform}|${teamId}|${room.id}`,
    );
    await this.prisma.chatLink.delete({ where: { id: link.id } });
  }

  // ------------------------------------------------------------ who is acting

  /**
   * The member a chat user acts as: the one already tied to them, else the member of the
   * Google account with the same email, else a new member named after them.
   */
  async member(roomId: string, user: ChatUser): Promise<Member> {
    // Anything a person does from a chat app counts as using the room.
    this.roomActivity.touch(roomId);
    const tied = await this.prisma.member.findFirst({
      where: { roomId, slackUserId: user.userId },
      orderBy: { createdAt: 'desc' },
    });
    if (tied?.kickedAt) throw new AppError('FORBIDDEN');
    if (tied && !tied.leftAt) {
      // A member made from Slack follows the person's Slack name; one that was named
      // after an id or the placeholder takes any better name we have.
      const wanted =
        tied.userId === null && user.profileName
          ? user.profileName
          : isPlaceholder(tied.displayName)
            ? user.name
            : '';
      const name = wanted ? await this.freeName(roomId, wanted, tied.id) : null;
      const rename = Boolean(name && name !== tied.displayName);
      // Their Slack picture, kept up to date (shown when no Google picture is behind them).
      const picture = user.avatarUrl && user.avatarUrl !== tied.avatarUrl;
      if (rename || picture) {
        return this.state.mutate(roomId, (tx) =>
          tx.member.update({
            where: { id: tied.id },
            data: {
              ...(rename && name
                ? { displayName: name, displayNameKey: nameKey(name) }
                : {}),
              ...(picture ? { avatarUrl: user.avatarUrl } : {}),
            },
          }),
        );
      }
      return tied;
    }

    if (user.email) {
      const account = await this.prisma.user.findFirst({
        where: { email: { equals: user.email, mode: 'insensitive' } },
      });
      const mine = account
        ? await this.prisma.member.findFirst({
            where: { roomId, userId: account.id, leftAt: null, kickedAt: null },
          })
        : null;
      if (mine) {
        return this.prisma.member.update({
          where: { id: mine.id },
          data: {
            slackUserId: user.userId,
            ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
          },
        });
      }
    }

    const room = await this.prisma.room.findUniqueOrThrow({
      where: { id: roomId },
      select: { settings: true },
    });
    const settings = readSettings(room.settings);
    const name = await this.freeName(
      roomId,
      user.name || CHAT_PLACEHOLDER_NAME,
    );
    if (name) {
      return this.state.mutate(roomId, async (tx, ctx) => {
        const m = await tx.member.create({
          data: {
            roomId,
            displayName: name,
            displayNameKey: nameKey(name),
            color:
              MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)],
            canDj: settings.allowGuestDj,
            slackUserId: user.userId,
            avatarUrl: user.avatarUrl ?? null,
          },
        });
        await this.activity.log(
          tx,
          ctx,
          roomId,
          m,
          'user_join',
          'đã vào phòng từ Slack',
          { variant: 'slack' },
        );
        return m;
      });
    }
    throw new AppError('NAME_TAKEN');
  }

  /** The first of "Lan", "Lan (Slack)", "Lan 2"… that nobody active in the room uses. */
  private async freeName(
    roomId: string,
    wanted: string,
    exceptId?: string,
  ): Promise<string | null> {
    const base = cleanLine(wanted).slice(0, 30) || CHAT_PLACEHOLDER_NAME;
    for (const name of [
      base,
      ...(base === CHAT_PLACEHOLDER_NAME
        ? []
        : [`${base.slice(0, 22)} (Slack)`]),
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base.slice(0, 26)} ${n}`),
    ]) {
      const taken = await this.prisma.member.findFirst({
        where: {
          roomId,
          displayNameKey: nameKey(name),
          leftAt: null,
          kickedAt: null,
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
      });
      if (!taken) return name;
    }
    return null;
  }

  private actor(m: Member, platform: ChatPlatformName): Actor {
    return {
      memberId: m.id,
      roomId: m.roomId,
      socketId: `chat:${platform}`,
      ip: `chat:${platform}`,
    };
  }

  /** "@Music Room <câu>" for the DJ (spec 2026-10-18-dj-chat): who acts, as the web would see them. */
  async asMember(
    roomId: string,
    user: ChatUser,
  ): Promise<{ member: Member; actor: Actor }> {
    const member = await this.member(roomId, user);
    return { member, actor: this.actor(member, user.platform) };
  }

  // ------------------------------------------------------------ actions

  async add(roomId: string, user: ChatUser, input: string) {
    const m = await this.member(roomId, user);
    return this.queue.add(this.actor(m, user.platform), { input });
  }

  /** Top results for a song name (free sources first, then YouTube under the member's limit). */
  async find(
    roomId: string,
    user: ChatUser,
    q: string,
  ): Promise<TrackSummary[]> {
    const m = await this.member(roomId, user);
    const { results } = await this.search.search(m.id, q);
    return results.slice(0, 3);
  }

  /** V1 vote from a chat app; the voter counts as present until the vote ends. */
  async vote(
    roomId: string,
    user: ChatUser,
    approve: boolean,
    itemId?: string,
  ): Promise<void> {
    const m = await this.member(roomId, user);
    const snap = await this.snapshots.build(roomId);
    const np = snap?.nowPlaying;
    if (!np) throw new AppError('STALE_ITEM');
    if (itemId && itemId !== np.item.id) throw new AppError('STALE_ITEM');
    const ends =
      np.skip.endsAt ??
      Date.now() + snap.room.settings.skipVoteWindowSec * 1000;
    this.presence.addChatVoter(roomId, m.id, ends + VOTER_GRACE_MS);
    await this.playback.voteSkip(
      this.actor(m, user.platform),
      np.item.id,
      approve,
    );
  }

  async react(roomId: string, user: ChatUser, emoji: Reaction): Promise<void> {
    const m = await this.member(roomId, user);
    await this.social.reaction(this.actor(m, user.platform), emoji);
  }

  async now(roomId: string): Promise<NowView | null> {
    this.roomActivity.touch(roomId);
    const snap = await this.snapshots.build(roomId);
    if (!snap) return null;
    const np = snap.nowPlaying;
    return {
      roomName: snap.room.name,
      roomCode: snap.room.code,
      roomUrl: `${this.env.PUBLIC_URL.replace(/\/$/, '')}/r/${snap.room.code}`,
      playing: np
        ? {
            itemId: np.item.id,
            title: np.item.track.title,
            thumbnailUrl: np.item.track.thumbnailUrl,
            pickedBy: np.item.addedBy?.displayName ?? null,
            paused: np.status === 'PAUSED',
            positionSec: np.positionSec,
            durationSec: np.item.track.durationSec,
          }
        : null,
      next: snap.queue.slice(0, 5).map((q) => ({
        title: q.track.title,
        pickedBy: q.addedBy?.displayName ?? null,
      })),
    };
  }

  async home(roomId: string): Promise<HomeView | null> {
    const snap = await this.snapshots.build(roomId);
    if (!snap) return null;
    const at = Date.now();
    const np = snap.nowPlaying;
    const track = (q: QueueItemView): HomeTrack => ({
      title: q.track.title,
      artist: q.track.artist,
      song: q.track.song,
      thumbnailUrl: q.track.thumbnailUrl,
      durationSec: q.track.durationSec,
      pickedBy: q.addedBy?.displayName ?? null,
      auto: q.auto,
      hearts: q.hearts,
    });
    const people = snap.members.filter((m) => !m.isDevice && m.online);
    // The snapshot's position is as of positionAt; carry it forward while playing.
    const position = np
      ? np.positionSec +
        (np.status === 'PLAYING' ? Math.max(0, at - np.positionAt) / 1000 : 0)
      : 0;
    return {
      at,
      roomId,
      roomName: snap.room.name,
      roomCode: snap.room.code,
      roomUrl: `${this.env.PUBLIC_URL.replace(/\/$/, '')}/r/${snap.room.code}`,
      present: people.map((m) => m.displayName),
      listening: snap.members.filter((m) => m.listening).length,
      playing: np
        ? {
            ...track(np.item),
            itemId: np.item.id,
            paused: np.status === 'PAUSED',
            positionSec: np.item.track.durationSec
              ? Math.min(position, np.item.track.durationSec)
              : position,
          }
        : null,
      vote:
        np && np.skip.endsAt !== null
          ? {
              openedBy: np.skip.openedBy?.displayName ?? null,
              votes: np.skip.votes,
              required: np.skip.required,
              against: np.skip.against,
              endsAt: np.skip.endsAt,
            }
          : null,
      blockedUntil:
        np?.skip.blockedUntil && np.skip.blockedUntil > at
          ? np.skip.blockedUntil
          : null,
      next: snap.queue.slice(0, 5).map(track),
      queueLength: snap.queue.length,
    };
  }
}
