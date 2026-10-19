import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { HTTP_TIMEOUT_MS } from './youtube.provider';

/** youtubei.js search filters the DJ uses for "newest / trending" (spec 2026-10-18-dj-chat). */
export interface SearchFilters {
  upload_date?: 'week' | 'month' | 'year';
  prioritize?: 'popularity';
}

/** A video found by YouTube's own web search (not yet checked through the Data API). */
export interface FoundVideo {
  externalId: string;
  title: string;
  channel: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
}

/** A song as YouTube Music knows it (title and artists are YouTube Music's own). */
export interface MusicSong {
  externalId: string;
  title: string;
  /** The artists joined with ", " ("Sơn Tùng M-TP"). */
  artist: string;
  durationSec: number | null;
}

/** Failures in a row before InnerTube is left alone for a while. */
export const INNERTUBE_MAX_FAILURES = 3;
export const INNERTUBE_COOLDOWN_MS = 30 * 60_000;
/** "Up next" is background work (radio, "giống bài đang phát"): a little more patience. */
const UP_NEXT_TIMEOUT_MS = 8000;
/** Result pages YouTube is asked for at most in one search (about 20 videos each). */
const MAX_PAGES = 4;
/** Shorts and clips this short are not songs. */
const MIN_DURATION_SEC = 60;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Nodes YouTube shows when a search has no results ("Không tìm thấy kết quả"…). */
const EMPTY_NOTICES = new Set([
  'BackgroundPromo',
  'Message',
  'ShowingResultsFor',
  'DidYouMean',
]);

type YouTubeJs = typeof import('youtubei.js');
type VideoNode = InstanceType<YouTubeJs['YTNodes']['Video']>;
type Innertube = Awaited<
  ReturnType<(typeof import('youtubei.js'))['Innertube']['create']>
>;

/**
 * Song search through InnerTube, the private API youtube.com itself uses (via the
 * youtubei.js library): no API key and no quota. Unofficial, so it may break or get
 * blocked; callers fall back to the Data API search, and repeated failures switch it
 * off for INNERTUBE_COOLDOWN_MS. `YOUTUBE_SEARCH_PROVIDER=api` turns it off entirely.
 */
@Injectable()
export class InnerTubeProvider {
  private readonly logger = new Logger(InnerTubeProvider.name);
  private client: Promise<Innertube> | null = null;
  private failures = 0;
  private offUntil = 0;
  /** "Up next" failing over and over (seen from some hosts): rested on its own, search stays on. */
  private upNextFailures = 0;
  private upNextOffUntil = 0;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return this.env.YOUTUBE_SEARCH_PROVIDER === 'innertube';
  }

  /** Enabled and not resting after repeated failures. */
  get available(): boolean {
    return this.enabled && Date.now() >= this.offUntil;
  }

  /**
   * Up to `max` songs (no Shorts, live streams or premieres), in YouTube's order, walking
   * its result pages as needed. `more`: YouTube had songs beyond these. Throws on failure.
   */
  async search(
    q: string,
    max: number,
    filters?: SearchFilters,
  ): Promise<{ videos: FoundVideo[]; more: boolean }> {
    try {
      const found = await this.find(q, max, filters);
      this.failures = 0;
      return found;
    } catch (e) {
      this.client = null; // a fresh session next time
      if (++this.failures >= INNERTUBE_MAX_FAILURES) {
        this.failures = 0;
        this.offUntil = Date.now() + INNERTUBE_COOLDOWN_MS;
        this.logger.warn(
          `InnerTube search failing, off for ${INNERTUBE_COOLDOWN_MS / 60_000} min: ${String(e)}`,
        );
      }
      throw e;
    }
  }

  private async find(
    q: string,
    max: number,
    filters?: SearchFilters,
  ): Promise<{ videos: FoundVideo[]; more: boolean }> {
    const yt = await this.session();
    let res = await withTimeout(
      yt.search(q, { type: 'video', ...filters }),
      HTTP_TIMEOUT_MS,
    );
    // A page we cannot read (layout changed) is a failure, not "no results".
    if (!Array.isArray(res.results))
      throw new Error('InnerTube: unexpected search response');
    // Only YouTube's own "no results" notices: truly nothing found.
    if (
      !res.videos.length &&
      res.results.every((n) => EMPTY_NOTICES.has(n.type))
    )
      return { videos: [], more: false };
    // Items we do not know at all (a new page layout): a failure, not "nothing".
    if (!res.videos.some((n) => n.type === 'Video'))
      throw new Error('InnerTube: unexpected search results');

    const out: FoundVideo[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page++) {
      for (const node of res.videos) {
        if (node.type !== 'Video') continue;
        const v = node as VideoNode;
        if (v.is_live || v.is_upcoming || seen.has(v.video_id)) continue;
        const seconds = v.duration.seconds;
        if (seconds > 0 && seconds < MIN_DURATION_SEC) continue;
        seen.add(v.video_id);
        out.push({
          externalId: v.video_id,
          title: v.title.toString() || v.video_id,
          channel:
            v.author.name && v.author.name !== 'N/A' ? v.author.name : null,
          durationSec: seconds > 0 ? seconds : null,
          thumbnailUrl: `https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg`,
        });
        if (out.length >= max) return { videos: out, more: true };
      }
      // Videos found but all Shorts / live: nothing usable is still a real answer.
      if (!res.has_continuation) return { videos: out, more: false };
      if (page >= MAX_PAGES) return { videos: out, more: true };
      res = await withTimeout(res.getContinuation(), HTTP_TIMEOUT_MS);
    }
  }

  /**
   * What YouTube itself would play after this video: YouTube Music's radio ("Phát tiếp",
   * up to ~50 songs by the same and related artists), else youtube.com's "Up next" feed.
   * Video ids in YouTube's order, without the video itself; [] when neither answers.
   */
  async upNext(videoId: string): Promise<string[]> {
    if (!this.available || Date.now() < this.upNextOffUntil) return [];
    const yt = await this.session();
    const own = (ids: (string | undefined)[]) => [
      ...new Set(
        ids.filter(
          (id): id is string =>
            typeof id === 'string' && VIDEO_ID.test(id) && id !== videoId,
        ),
      ),
    ];
    // Both at once: the youtube.com feed is only a stand-in, but waiting for one to time out
    // before asking the other doubled the wait.
    const [music, web] = await Promise.allSettled([
      withTimeout(yt.music.getUpNext(videoId, true), UP_NEXT_TIMEOUT_MS).then(
        (radio) =>
          own(
            (radio.contents ?? []).map(
              (x) => (x as { video_id?: string }).video_id,
            ),
          ),
      ),
      withTimeout(yt.getInfo(videoId), UP_NEXT_TIMEOUT_MS).then((info) =>
        own(
          (info.watch_next_feed ?? []).map((x) => {
            const n = x as {
              video_id?: string;
              id?: string;
              content_id?: string;
            };
            return n.video_id ?? n.content_id ?? n.id;
          }),
        ),
      ),
    ]);
    if (music.status === 'fulfilled' || web.status === 'fulfilled') {
      this.upNextFailures = 0;
      if (music.status === 'fulfilled' && music.value.length)
        return music.value;
      return web.status === 'fulfilled' ? web.value : [];
    }
    // Neither answered: a fresh session next time; after a few in a row, rest "up next".
    this.client = null;
    const why = `${String(music.reason)} / ${String(web.reason)}`;
    if (++this.upNextFailures >= INNERTUBE_MAX_FAILURES) {
      this.upNextFailures = 0;
      this.upNextOffUntil = Date.now() + INNERTUBE_COOLDOWN_MS;
      this.logger.warn(
        `YouTube up next keeps failing, off for ${INNERTUBE_COOLDOWN_MS / 60_000} min: ${why}`,
      );
    } else this.logger.warn(`YouTube up next for ${videoId} failed: ${why}`);
    return [];
  }

  /**
   * The artist YouTube Music finds first for a name the user typed ("j97" → "Jack - J97"), when
   * the two names share a word; null when there is no such artist. Throws on failure.
   */
  async musicArtist(
    name: string,
  ): Promise<{ name: string; channelId: string | null } | null> {
    return this.counted(async () => {
      const yt = await this.session();
      const res = await withTimeout(
        yt.music.search(name, { type: 'artist' }),
        HTTP_TIMEOUT_MS,
      );
      const first = (res.contents ?? [])
        .flatMap((s) => (s as { contents?: unknown[] }).contents ?? [])
        .map((x) => x as { item_type?: string; name?: string; id?: string })
        .find((x) => x.item_type === 'artist' && x.name);
      if (!first?.name) return null;
      return sharesWord(first.name, name)
        ? { name: first.name, channelId: first.id ?? null }
        : null;
    });
  }

  /** Songs (not videos) on YouTube Music, in its order: official audio of the real artist. Throws on failure. */
  async musicSongs(query: string, max: number): Promise<MusicSong[]> {
    return this.counted(async () => {
      const yt = await this.session();
      const res = await withTimeout(
        yt.music.search(query, { type: 'song' }),
        HTTP_TIMEOUT_MS,
      );
      const out: MusicSong[] = [];
      for (const s of res.contents ?? [])
        for (const x of (s as { contents?: unknown[] }).contents ?? []) {
          const it = x as {
            item_type?: string;
            id?: string;
            title?: string;
            artists?: { name?: string }[];
            duration?: { seconds?: number };
          };
          if (
            it.item_type !== 'song' ||
            !it.id ||
            !VIDEO_ID.test(it.id) ||
            !it.title
          )
            continue;
          const seconds = it.duration?.seconds ?? 0;
          out.push({
            externalId: it.id,
            title: it.title,
            artist: (it.artists ?? [])
              .map((a) => a.name)
              .filter(Boolean)
              .join(', '),
            durationSec: seconds > 0 ? seconds : null,
          });
          if (out.length >= max) return out;
        }
      return out;
    });
  }

  /**
   * An artist's page on YouTube Music: "Bài hát hàng đầu" (their most played songs, credited to
   * them) and their releases, newest first (singles and EPs, then albums). Throws on failure.
   */
  async musicArtistPage(channelId: string): Promise<{
    top: MusicSong[];
    releases: { id: string; title: string; year: number | null }[];
  }> {
    return this.counted(async () => {
      const yt = await this.session();
      const page = await withTimeout(
        yt.music.getArtist(channelId),
        HTTP_TIMEOUT_MS,
      );
      type Item = {
        item_type?: string;
        id?: string;
        title?: string | { toString(): string };
        artists?: { name?: string }[];
        duration?: { seconds?: number };
        year?: string;
      };
      const sections = (page.sections ?? []) as unknown as {
        type?: string;
        contents?: Item[];
      }[];
      const top: MusicSong[] = [];
      for (const it of sections.find((s) => s.type === 'MusicShelf')
        ?.contents ?? []) {
        const title = it.title?.toString();
        if (
          it.item_type !== 'song' ||
          !it.id ||
          !VIDEO_ID.test(it.id) ||
          !title
        )
          continue;
        const seconds = it.duration?.seconds ?? 0;
        top.push({
          externalId: it.id,
          title,
          artist: (it.artists ?? [])
            .map((a) => a.name)
            .filter(Boolean)
            .join(', '),
          durationSec: seconds > 0 ? seconds : null,
        });
      }
      // Each carousel of albums / singles is newest first; a stable sort by year merges them.
      const releases = sections
        .flatMap((s) => s.contents ?? [])
        .filter((it) => it.item_type === 'album' && it.id)
        .map((it) => ({
          id: it.id!,
          title: it.title?.toString() ?? '',
          year: Number(it.year) || null,
        }))
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      return { top, releases };
    });
  }

  /** The songs of a YouTube Music album / single, in order. Throws on failure. */
  async musicAlbumSongs(browseId: string): Promise<MusicSong[]> {
    return this.counted(async () => {
      const yt = await this.session();
      const album = await withTimeout(
        yt.music.getAlbum(browseId),
        HTTP_TIMEOUT_MS,
      );
      const out: MusicSong[] = [];
      for (const x of (album.contents ?? []) as unknown as {
        id?: string;
        title?: string | { toString(): string };
        artists?: { name?: string }[];
        duration?: { seconds?: number };
      }[]) {
        const title = x.title?.toString();
        if (!x.id || !VIDEO_ID.test(x.id) || !title) continue;
        const seconds = x.duration?.seconds ?? 0;
        out.push({
          externalId: x.id,
          title,
          artist: (x.artists ?? [])
            .map((a) => a.name)
            .filter(Boolean)
            .join(', '),
          durationSec: seconds > 0 ? seconds : null,
        });
      }
      return out;
    });
  }

  /** Same failure counting as `search`: repeated failures rest InnerTube for a while. */
  private async counted<T>(run: () => Promise<T>): Promise<T> {
    if (!this.available) throw new Error('InnerTube: resting');
    try {
      const r = await run();
      this.failures = 0;
      return r;
    } catch (e) {
      this.client = null;
      if (++this.failures >= INNERTUBE_MAX_FAILURES) {
        this.failures = 0;
        this.offUntil = Date.now() + INNERTUBE_COOLDOWN_MS;
        this.logger.warn(
          `InnerTube failing, off for ${INNERTUBE_COOLDOWN_MS / 60_000} min: ${String(e)}`,
        );
      }
      throw e;
    }
  }

  private session(): Promise<Innertube> {
    // youtubei.js is ESM-only: loaded on first use with a real dynamic import.
    this.client ??= import('youtubei.js').then(({ Innertube }) =>
      Innertube.create({ lang: 'vi', location: 'VN', retrieve_player: false }),
    );
    return this.client;
  }
}

/**
 * Two names share a word of 2+ letters (accents and case aside): "Jack - J97" / "j97". A typo
 * counts as the same word ("ryhder" / "RHYDER"): YouTube Music corrects it, the check must too.
 * Short words must match exactly ("den" is not "dan").
 */
function sharesWord(a: string, b: string): boolean {
  const ws = (t: string) =>
    new Set(
      t
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/đ/gi, 'd')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 2),
    );
  const x = [...ws(a)];
  return [...ws(b)].some((w) => x.some((v) => v === w || typoOf(v, w)));
}

/** Letters swapped, missing, extra or wrong: 1 for words of 4–6 letters, 2 from 7 letters. */
function typoOf(a: string, b: string): boolean {
  const len = Math.min(a.length, b.length);
  const max = len >= 7 ? 2 : len >= 4 ? 1 : 0;
  return (
    max > 0 && Math.abs(a.length - b.length) <= max && editDistance(a, b) <= max
  );
}

/** Optimal string alignment distance (Levenshtein plus swapping two neighbours). */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`InnerTube: timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
