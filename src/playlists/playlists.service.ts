import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error';
import {
  MAX_PLAYLIST_TRACKS,
  MAX_PLAYLISTS,
  type PlaylistKind,
  type PlaylistSummaryView,
  type PlaylistView,
} from '../contracts';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { Broadcaster } from '../realtime/broadcaster.service';
import { toTrackSummary } from '../state/views';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const newShareCode = () =>
  Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
    '',
  );

/** L2: personal playlists of signed-in users. Every write checks ownership. */
/**
 * Playlists the app named itself ("Đã thích trên YouTube", "Dành cho bạn"): clients show the
 * name in the reader's language. The stored name stays as it is.
 */
function playlistKind(source: string | null): PlaylistKind | null {
  if (source === 'yt:liked') return 'liked';
  if (source === 'mix:foryou') return 'mix';
  return null;
}

@Injectable()
export class PlaylistsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcaster: Broadcaster,
  ) {}

  /** Every tab of the account refreshes its lists (DJ saves, other devices, this tab). */
  private changed(userId: string, playlistId: string | null): void {
    this.broadcaster.toUser(userId, 'playlist:changed', { playlistId });
  }

  private async owned(db: Tx | PrismaService, userId: string, id: string) {
    const p = await db.playlist.findUnique({ where: { id } });
    if (!p || p.ownerId !== userId) throw new AppError('PLAYLIST_NOT_FOUND');
    return p;
  }

  /** Known, playable tracks among `ids`, in the order given (unknown ones dropped). */
  private async playable(
    db: Tx | PrismaService,
    ids: string[],
  ): Promise<string[]> {
    const rows = await db.track.findMany({
      where: { id: { in: ids }, embeddable: true, title: { not: '' } },
      select: { id: true },
    });
    const ok = new Set(rows.map((r) => r.id));
    return [...new Set(ids)].filter((id) => ok.has(id));
  }

  async mine(userId: string, trackId?: string): Promise<PlaylistSummaryView[]> {
    const rows = await this.prisma.playlist.findMany({
      where: { ownerId: userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { items: true } },
        items: {
          orderBy: { position: 'asc' },
          take: 1,
          include: { track: { select: { thumbnailUrl: true } } },
        },
      },
    });
    const containing = trackId
      ? new Set(
          (
            await this.prisma.playlistItem.findMany({
              where: { trackId, playlist: { ownerId: userId } },
              select: { playlistId: true },
            })
          ).map((i) => i.playlistId),
        )
      : null;
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      trackCount: p._count.items,
      coverUrl: p.items[0]?.track.thumbnailUrl ?? null,
      shared: p.shareCode !== null,
      updatedAt: p.updatedAt.toISOString(),
      kind: playlistKind(p.source),
      ...(containing ? { hasTrack: containing.has(p.id) } : {}),
    }));
  }

  async create(
    userId: string,
    name: string,
    trackIds: string[] = [],
  ): Promise<string> {
    const id = await this.prisma.$transaction(async (tx) => {
      const count = await tx.playlist.count({ where: { ownerId: userId } });
      if (count >= MAX_PLAYLISTS)
        throw new AppError('PLAYLIST_LIMIT', { max: MAX_PLAYLISTS });
      const ids = (await this.playable(tx, trackIds)).slice(
        0,
        MAX_PLAYLIST_TRACKS,
      );
      const p = await tx.playlist.create({
        data: {
          ownerId: userId,
          name,
          items: {
            create: ids.map((trackId, position) => ({ trackId, position })),
          },
        },
      });
      return p.id;
    });
    this.changed(userId, id);
    return id;
  }

  async update(
    userId: string,
    id: string,
    patch: { name?: string; description?: string },
  ): Promise<void> {
    await this.owned(this.prisma, userId, id);
    await this.prisma.playlist.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description || null }
          : {}),
      },
    });
    this.changed(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.owned(this.prisma, userId, id);
    await this.prisma.playlist.delete({ where: { id } });
    this.changed(userId, id);
  }

  /** Adds a song at the end, or takes it out (positions stay gap-free). */
  async setTrack(
    userId: string,
    id: string,
    trackId: string,
    saved: boolean,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.owned(tx, userId, id);
      const existing = await tx.playlistItem.findUnique({
        where: { playlistId_trackId: { playlistId: id, trackId } },
      });
      if (saved && !existing) {
        const count = await tx.playlistItem.count({
          where: { playlistId: id },
        });
        if (count >= MAX_PLAYLIST_TRACKS)
          throw new AppError('PLAYLIST_FULL', { max: MAX_PLAYLIST_TRACKS });
        if (!(await this.playable(tx, [trackId])).length)
          throw new AppError('TRACK_NOT_FOUND');
        await tx.playlistItem.create({
          data: { playlistId: id, trackId, position: count },
        });
      } else if (!saved && existing) {
        await tx.playlistItem.delete({ where: { id: existing.id } });
        await tx.playlistItem.updateMany({
          where: { playlistId: id, position: { gt: existing.position } },
          data: { position: { decrement: 1 } },
        });
      }
      await tx.playlist.update({
        where: { id },
        data: { updatedAt: new Date() },
      });
    });
    this.changed(userId, id);
  }

  /** Moves a song to index `to` (clamped), shifting the songs in between. */
  async move(
    userId: string,
    id: string,
    trackId: string,
    to: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.owned(tx, userId, id);
      const items = await tx.playlistItem.findMany({
        where: { playlistId: id },
        orderBy: { position: 'asc' },
      });
      const from = items.findIndex((i) => i.trackId === trackId);
      if (from < 0) throw new AppError('STALE_ITEM');
      const target = Math.max(0, Math.min(to, items.length - 1));
      if (target === from) return;
      const [moved] = items.splice(from, 1);
      items.splice(target, 0, moved);
      for (const [i, it] of items.entries())
        if (it.position !== i)
          await tx.playlistItem.update({
            where: { id: it.id },
            data: { position: i },
          });
      await tx.playlist.update({
        where: { id },
        data: { updatedAt: new Date() },
      });
    });
    this.changed(userId, id);
  }

  /** By id (owner only) or by share code (anyone). */
  async get(
    userId: string | undefined,
    by: { id: string } | { shareCode: string },
  ): Promise<PlaylistView> {
    const p = await this.prisma.playlist.findUnique({
      where: 'id' in by ? { id: by.id } : { shareCode: by.shareCode },
      include: {
        owner: { select: { name: true } },
        items: { orderBy: { position: 'asc' }, include: { track: true } },
      },
    });
    const isOwner = Boolean(p && userId && p.ownerId === userId);
    if (!p || ('id' in by && !isOwner))
      throw new AppError('PLAYLIST_NOT_FOUND');
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      owner: { name: p.owner.name },
      isOwner,
      shareCode: isOwner ? p.shareCode : null,
      // The retention job blanks songs YouTube no longer allows us to keep: skip them.
      tracks: p.items
        .filter((i) => i.track.title !== '')
        .map((i) => toTrackSummary(i.track)),
      kind: playlistKind(p.source),
    };
  }

  /** On: a fresh code (an old link stops working). Off: no link at all. */
  async share(
    userId: string,
    id: string,
    enabled: boolean,
  ): Promise<string | null> {
    await this.owned(this.prisma, userId, id);
    for (let attempt = 0; attempt < 5; attempt++) {
      const shareCode = enabled ? newShareCode() : null;
      try {
        await this.prisma.playlist.update({
          where: { id },
          data: { shareCode },
        });
        this.changed(userId, id);
        return shareCode;
      } catch (e) {
        if (!enabled || attempt === 4) throw e; // a code collision: try another one
      }
    }
    return null;
  }

  async copy(userId: string, shareCode: string): Promise<string> {
    const src = await this.get(userId, { shareCode });
    return this.create(
      userId,
      src.name.slice(0, 60),
      src.tracks.map((t) => t.id),
    );
  }

  /**
   * L3: an imported playlist — created the first time, its songs replaced on every
   * later import from the same source (the user's own edits to it are overwritten).
   */
  async saveFromSource(
    userId: string,
    source: string,
    name: string,
    trackIds: string[],
  ): Promise<string> {
    const existing = await this.prisma.playlist.findUnique({
      where: { ownerId_source: { ownerId: userId, source } },
    });
    if (!existing) {
      const id = await this.create(userId, name, trackIds);
      await this.prisma.playlist.update({ where: { id }, data: { source } });
      return id;
    }
    await this.prisma.$transaction(async (tx) => {
      const ids = (await this.playable(tx, trackIds)).slice(
        0,
        MAX_PLAYLIST_TRACKS,
      );
      await tx.playlistItem.deleteMany({ where: { playlistId: existing.id } });
      await tx.playlistItem.createMany({
        data: ids.map((trackId, position) => ({
          playlistId: existing.id,
          trackId,
          position,
        })),
      });
      await tx.playlist.update({
        where: { id: existing.id },
        data: { name, updatedAt: new Date() },
      });
    });
    this.changed(userId, existing.id);
    return existing.id;
  }
}
