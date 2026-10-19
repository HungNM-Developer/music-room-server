import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error';
import type { Track } from '../generated/prisma/client';
import { normalizeQuery } from '../contracts';
import { PrismaService } from '../prisma/prisma.service';
import { type TrackInfo, YouTubeProvider } from './youtube.provider';

export const TRACK_TTL_MS = 7 * 24 * 3600_000;
export const trackId = (videoId: string) => `youtube:${videoId}`;

/** What library search matches against: title and channel, accents and case removed. */
export const trackSearchKey = (title: string, channel: string | null) =>
  normalizeQuery(`${title} ${channel ?? ''}`);

/** Track metadata cache (R-36): 7 days, refreshed when a stale track is added again. */
@Injectable()
export class TrackCacheService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly youtube: YouTubeProvider,
  ) {}

  /** Playable track for `videoId` or a TRACK_* AppError (R-17). Runs outside room transactions. */
  async resolve(videoId: string): Promise<Track> {
    const cached = await this.prisma.track.findUnique({
      where: { id: trackId(videoId) },
    });
    if (cached && Date.now() - cached.fetchedAt.getTime() < TRACK_TTL_MS) {
      if (!cached.embeddable) throw new AppError('TRACK_NOT_EMBEDDABLE');
      return cached;
    }
    const info = await this.youtube.getTrack(videoId);
    if (info.live) throw new AppError('TRACK_LIVE');
    const row = await this.upsert(info);
    if (!info.embeddable) throw new AppError('TRACK_NOT_EMBEDDABLE');
    return row;
  }

  /**
   * A player said "Video unavailable": asks YouTube again (Data API, the country's block
   * included) and stores the answer. false = not playable here (or gone); true = YouTube
   * says it plays, so the error was the player's own.
   */
  async recheck(videoId: string): Promise<boolean> {
    try {
      const info = await this.youtube.getTrack(videoId);
      await this.upsert(info);
      return info.embeddable && !info.live;
    } catch (e) {
      if (
        e instanceof AppError &&
        (e.code === 'TRACK_NOT_FOUND' || e.code === 'TRACK_NOT_EMBEDDABLE')
      ) {
        await this.markUnplayable(videoId);
        return false;
      }
      throw e;
    }
  }

  /** Never offered again (radio, suggestions, library): the video does not play here. */
  async markUnplayable(videoId: string): Promise<void> {
    await this.prisma.track.updateMany({
      where: { id: trackId(videoId) },
      data: { embeddable: false },
    });
  }

  upsert(info: TrackInfo): Promise<Track> {
    const data = {
      provider: 'youtube',
      externalId: info.externalId,
      title: info.title,
      channel: info.channel,
      durationSec: info.durationSec,
      thumbnailUrl: info.thumbnailUrl,
      embeddable: info.embeddable,
      fetchedAt: new Date(),
      searchKey: trackSearchKey(info.title, info.channel),
    };
    return this.prisma.track.upsert({
      where: { id: trackId(info.externalId) },
      create: { id: trackId(info.externalId), ...data },
      update: data,
    });
  }
}
