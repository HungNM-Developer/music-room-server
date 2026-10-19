import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env';

/**
 * Last.fm (free key): canonical artist / song names (AI1) and similar tracks and artists
 * (A3, A4). Answers are cached in memory for CACHE_MS; without a key every call returns
 * an empty answer, so callers need no special case.
 */

const API = 'https://ws.audioscrobbler.com/2.0/';
const TIMEOUT_MS = 6000;
const CACHE_MS = 6 * 3600_000;
const CACHE_MAX = 2000;
/** Unreachable / 5xx this many times in a row: rest a little (no requests, no logs). */
const MAX_FAILURES = 3;
const REST_AFTER_FAILURES_MS = 2 * 60_000;

export interface LastFmTrack {
  artist: string;
  song: string;
  /** 0–1 for similar tracks; listeners for getInfo. */
  score: number;
}

@Injectable()
export class LastFmService {
  private readonly logger = new Logger(LastFmService.name);
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private failingUntil = 0;
  private failures = 0;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return Boolean(this.env.LASTFM_API_KEY);
  }

  private async call(params: Record<string, string>): Promise<unknown> {
    const key = this.env.LASTFM_API_KEY;
    if (!key || Date.now() < this.failingUntil) return null;
    const cacheKey = JSON.stringify(params);
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const url = new URL(API);
    for (const [k, v] of Object.entries({
      ...params,
      api_key: key,
      format: 'json',
      autocorrect: '1',
    }))
      url.searchParams.set(k, v);
    const get = () => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const pause = () => new Promise((r) => setTimeout(r, 1500));
    try {
      // A network error, a timeout or a 5xx (Last.fm is sometimes briefly down) gets one
      // more try after a short pause.
      let res: Response;
      try {
        res = await get();
      } catch {
        await pause();
        res = await get();
      }
      if (res.status >= 500) {
        await pause();
        res = await get();
      }
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { error?: number; message?: string };
      // 6 = not found: a real answer, cache it. 29 = rate limited, 10/26 = bad key.
      if (body.error && body.error !== 6) {
        if ([10, 26, 29].includes(body.error))
          this.failingUntil = Date.now() + 10 * 60_000;
        throw new Error(`Last.fm ${body.error}: ${body.message ?? ''}`);
      }
      const value = body.error ? null : body;
      this.failures = 0;
      if (this.cache.size >= CACHE_MAX)
        this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(cacheKey, { at: Date.now(), value });
      return value;
    } catch (e) {
      if (++this.failures >= MAX_FAILURES) {
        this.failures = 0;
        this.failingUntil = Math.max(
          this.failingUntil,
          Date.now() + REST_AFTER_FAILURES_MS,
        );
        this.logger.warn(
          `Last.fm keeps failing, resting ${REST_AFTER_FAILURES_MS / 60_000} min: ${String(e)}`,
        );
      } else this.logger.warn(`${params.method} failed: ${String(e)}`);
      return null;
    }
  }

  /** Canonical names when Last.fm knows this artist + song, else null. */
  async trackInfo(artist: string, song: string): Promise<LastFmTrack | null> {
    const body = (await this.call({
      method: 'track.getInfo',
      artist,
      track: song,
    })) as {
      track?: { name?: string; listeners?: string; artist?: { name?: string } };
    } | null;
    const t = body?.track;
    if (!t?.name || !t.artist?.name) return null;
    const listeners = Number(t.listeners ?? 0);
    // Anything can be scrobbled once: a handful of listeners is not a confirmation.
    if (listeners < 50) return null;
    return { artist: t.artist.name, song: t.name, score: listeners };
  }

  async similarTracks(
    artist: string,
    song: string,
    limit = 40,
  ): Promise<LastFmTrack[]> {
    const body = (await this.call({
      method: 'track.getSimilar',
      artist,
      track: song,
      limit: String(limit),
    })) as {
      similartracks?: {
        track?: { name?: string; match?: number; artist?: { name?: string } }[];
      };
    } | null;
    return (body?.similartracks?.track ?? [])
      .filter((t) => t.name && t.artist?.name)
      .map((t) => ({
        artist: t.artist!.name!,
        song: t.name!,
        score: Number(t.match ?? 0),
      }));
  }

  async similarArtists(artist: string, limit = 20): Promise<string[]> {
    const body = (await this.call({
      method: 'artist.getSimilar',
      artist,
      limit: String(limit),
    })) as {
      similarartists?: { artist?: { name?: string }[] };
    } | null;
    return (body?.similarartists?.artist ?? [])
      .map((a) => a.name ?? '')
      .filter(Boolean);
  }
}
