import { Inject, Injectable } from '@nestjs/common';
import type { MemberView, RoomSnapshot } from '../contracts';
import { ENV, type Env } from '../config/env';
import { LeaseService } from '../playback/lease.service';
import { countVotes, requiredVotes } from '../playback/skip-votes';
import { PrismaService } from '../prisma/prisma.service';
import { orderQueue } from '../queue/fair-queue';
import { PresenceService } from '../realtime/presence.service';
import { readSettings } from './settings';
import {
  estimatePosition,
  ITEM_INCLUDE,
  type ItemWithRelations,
  toItemView,
} from './views';
import { TtsService } from '../tts/tts.service';

/** A Google account picture at 72 px (avatars are at most 36 px): its URL ends in "=s96-c". */
export function smallPicture(url: string | null | undefined): string | null {
  if (!url) return null;
  return /googleusercontent\.com\//.test(url)
    ? url.replace(/=s\d+(-c)?$/, '=s72-c')
    : url;
}

@Injectable()
export class SnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly lease: LeaseService,
    @Inject(ENV) private readonly env: Env,
    private readonly tts: TtsService,
  ) {}

  /** Members that still count for votes: online (or voting from a chat app), not a device (R-25). */
  onlineVoters(
    roomId: string,
    members: { id: string; isDevice: boolean }[],
  ): Set<string> {
    const online = this.presence.onlineMembers(roomId);
    for (const id of this.presence.activeChatVoters(roomId)) online.add(id);
    return new Set(
      members.filter((m) => !m.isDevice && online.has(m.id)).map((m) => m.id),
    );
  }

  async build(roomId: string): Promise<RoomSnapshot | null> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: {
        playback: true,
        members: {
          where: { leftAt: null, kickedAt: null },
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { picture: true } } },
        },
        blockedTracks: {
          select: { trackId: true },
          orderBy: { trackId: 'asc' },
        },
      },
    });
    if (!room || !room.playback) return null;
    const ps = room.playback;
    const now = Date.now();
    const settings = readSettings(room.settings);
    const online = this.presence.onlineMembers(roomId);

    const [queued, current] = await Promise.all([
      this.prisma.queueItem.findMany({
        where: { roomId, status: 'QUEUED' },
        include: ITEM_INCLUDE,
      }),
      ps.currentItemId
        ? this.prisma.queueItem.findUnique({
            where: { id: ps.currentItemId },
            include: {
              ...ITEM_INCLUDE,
              skipVotes: { select: { memberId: true, approve: true } },
            },
          })
        : null,
    ]);

    const ordered = orderQueue(
      queued.map((q) => ({
        ...q,
        addedAt: q.addedAt.getTime(),
        pinnedAt: q.pinnedAt?.getTime() ?? null,
        hearts: q.hearts.length,
        _row: q,
      })),
    );

    const members: MemberView[] = room.members.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      color: m.color,
      role: m.role,
      isDevice: m.isDevice,
      canPlay: m.canPlay,
      canControl: m.canControl,
      canDj: m.canDj,
      online: online.has(m.id),
      listening: this.presence.isListening(m.id),
      // The Google account's picture first, else the Slack one.
      avatarUrl: smallPicture(m.user?.picture) ?? m.avatarUrl ?? null,
      verified: Boolean(m.userId),
      viaSlack: Boolean(m.slackUserId),
    }));

    let nowPlaying: RoomSnapshot['nowPlaying'] = null;
    if (current && ps.status !== 'IDLE') {
      const voters = this.onlineVoters(roomId, room.members);
      const tally = (approve: boolean) =>
        countVotes(
          current.skipVotes
            .filter((v) => v.approve === approve)
            .map((v) => v.memberId),
          voters,
        );
      const yes = tally(true);
      const no = tally(false);
      const opener = current.skipVoteById
        ? room.members.find((m) => m.id === current.skipVoteById)
        : undefined;
      const blocked = current.skipBlockedUntil?.getTime() ?? null;
      nowPlaying = {
        item: toItemView(current, (text, voice) =>
          this.tts.speech(text, voice),
        ),
        status: ps.status,
        positionSec: estimatePosition(ps, now),
        positionAt: now,
        skip: {
          ...yes,
          against: no.votes,
          againstVoters: no.voters,
          required: requiredVotes(voters.size, settings.skipThreshold),
          openedBy: opener
            ? { id: opener.id, displayName: opener.displayName }
            : null,
          endsAt: current.skipVoteEndsAt?.getTime() ?? null,
          blockedUntil: blocked !== null && blocked > now ? blocked : null,
        },
      };
    }

    return {
      version: ps.version,
      serverTime: now,
      room: {
        code: room.code,
        name: room.name,
        settings,
        hasPin: room.adminPinHash !== null,
        blockedTrackIds: room.blockedTracks.map((b) => b.trackId),
        ownerUserId: room.ownerId,
      },
      members,
      queue: ordered.map((o) => toItemView(o._row as ItemWithRelations)),
      status: nowPlaying ? ps.status : 'IDLE',
      nowPlaying,
      player: {
        memberId: ps.playerMemberId,
        online: this.lease.isOnline(roomId),
      },
      // InnerTube needs no key: searching works without one too.
      searchEnabled:
        Boolean(this.env.YOUTUBE_API_KEY) ||
        this.env.YOUTUBE_SEARCH_PROVIDER === 'innertube',
      aiEnabled: Boolean(
        this.env.GEMINI_API_KEY ||
        this.env.GROQ_API_KEY ||
        (this.env.OPENROUTER_API_KEY && this.env.OPENROUTER_MODEL),
      ),
    };
  }
}
