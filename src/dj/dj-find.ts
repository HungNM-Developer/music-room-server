import { Injectable, Logger } from '@nestjs/common';
import { DjService } from '../ai/dj.service';
import { normalizeQuery, type TrackSummary } from '../contracts';
import { InnerTubeProvider, type MusicSong } from '../music/innertube.provider';
import { SearchService } from '../music/search.service';
import { SnapshotService } from '../state/snapshot.service';
import { findFresh } from './dj-fresh';
import type { Find } from './dj-plan';
import {
  type Artist,
  artistMatch,
  creditsArtist,
  DjResolver,
} from './dj-resolve';

/** A song worth trying, already checked against what was asked for. */
export interface Candidate {
  externalId: string;
  title: string;
  /** Who it is by: YouTube Music's credits, or the video's channel. */
  artist?: string | null;
  /** A real "newest / trending" lookup found it. */
  fresh?: 'latest' | 'popular';
}

/** Not the song itself, unless the asker typed that word ("bản remix", "acoustic"…). */
const NOT_THE_SONG =
  /\b(cover|karaoke|reaction|react|remix|mashup|beat|instrumental|lyrics?|loi bai hat|live|nightcore|8d|slowed|speed up|sped up|tong hop|tuyen tap|lien khuc|nonstop|mix|hay nhat|top \d+|top nhung|khong loi|acoustic|piano|vinahouse|vina house|edm|guitar|lofi|lo-fi|ver|version|ballad|tiktok|playlist|full album|teaser|trailer|shorts?)\b/;
const MAX_SEC = 600;
/** YouTube Music answers looked at per search. */
const LOOK_AT = 15;

/** The song name inside a title, as whole words ("Lạc Trôi" in "Lạc Trôi (Official MV)"). */
function named(title: string, song: string): boolean {
  const t = ` ${normalizeQuery(title).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const s = normalizeQuery(song)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return Boolean(s) && t.includes(` ${s} `);
}

/** The song a title is about, for spotting two uploads of one song ("Đen - Lối Nhỏ ft. … (M/V)" = "Lối Nhỏ (cùng với …)"). */
function songKey(title: string): string {
  let t = normalizeQuery(title).replace(/[([{|].*$/, '');
  if (t.includes(' - ')) t = t.slice(t.indexOf(' - ') + 3);
  return t
    .replace(/\s(ft\.?|feat\.?|x|cung voi)\s.*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A word that marks a cover / remix… and that the asker did not use themselves. */
function notTheSong(title: string, asked: string): boolean {
  const m = NOT_THE_SONG.exec(normalizeQuery(title));
  return Boolean(m && !normalizeQuery(asked).includes(m[0]));
}

/**
 * Songs for the AI translator's "find" (spec 2026-10-18-dj-translator, "Tìm bài"): the room's
 * library, YouTube Music songs, YouTube videos, then the Data API. Every candidate matches the
 * names asked for: a wrong song added counts as a failure, so "close enough" is never offered.
 */
@Injectable()
export class DjFinder {
  private readonly logger = new Logger(DjFinder.name);

  constructor(
    private readonly resolver: DjResolver,
    private readonly innertube: InnerTubeProvider,
    private readonly search: SearchService,
    private readonly dj: DjService,
    private readonly snapshots: SnapshotService,
  ) {}

  /** The artist as YouTube Music names it, for the answer and for matching. */
  artistOf(find: Find): Promise<Artist | undefined> {
    return find.artist
      ? this.resolver.artist(find.artist)
      : Promise.resolve(undefined);
  }

  async *candidates(
    memberId: string,
    roomId: string,
    find: Find,
  ): AsyncGenerator<Candidate> {
    const artist = await this.artistOf(find);
    const exArtist = find.exclude?.artist
      ? await this.resolver.artist(find.exclude.artist)
      : undefined;
    const seen = new Set<string>();
    const songs = new Set<string>();
    const ok = (c: Candidate): boolean => {
      const key = songKey(c.title);
      if (seen.has(c.externalId) || (key && songs.has(key))) return false;
      if (find.exclude?.titles?.some((t) => named(c.title, t))) return false;
      if (
        exArtist &&
        (creditsArtist(c.artist ?? '', exArtist) ||
          artistMatch({ ...emptyTrack, title: c.title }, exArtist) === 'yes')
      )
        return false;
      seen.add(c.externalId);
      if (key) songs.add(key);
      return true;
    };
    const source = find.titles?.length
      ? this.byTitles(memberId, find.titles, artist)
      : find.mode === 'similar_now'
        ? this.similar(roomId)
        : find.mode === 'mood' || find.picks || find.mood
          ? this.byMood(find)
          : artist
            ? this.byArtist(memberId, artist, find.mode)
            : null;
    if (!source) return;
    for await (const c of source) if (ok(c)) yield c;
  }

  // ------------------------------------------------------------------ sources

  private async *byTitles(
    memberId: string,
    titles: string[],
    artist?: Artist,
  ): AsyncGenerator<Candidate> {
    for (const song of titles) {
      const asked = `${song} ${artist?.name ?? ''}`.trim();
      if (artist) {
        const known = await this.dj
          .findKnown(artist.name, song)
          .catch(() => null);
        if (
          known &&
          named(known.title, song) &&
          !notTheSong(known.title, asked)
        )
          yield {
            externalId: known.externalId,
            title: known.title,
            artist: known.artist ?? known.channel,
          };
      }
      const songs = await this.musicSongs(asked);
      // Same name first ("Lạc Trôi" before "Lạc Trôi (Triple D Remix)").
      const fits = songs
        .filter((s) => named(s.title, song) && !notTheSong(s.title, asked))
        .filter((s) => !artist || creditsArtist(s.artist, artist))
        .sort(
          (a, b) =>
            Number(normalizeQuery(b.title) === normalizeQuery(song)) -
            Number(normalizeQuery(a.title) === normalizeQuery(song)),
        );
      for (const s of fits)
        yield { externalId: s.externalId, title: s.title, artist: s.artist };
      for (const v of await this.videos(memberId, asked))
        if (
          named(v.title, song) &&
          !notTheSong(v.title, asked) &&
          (!artist ||
            artistMatch(
              { ...emptyTrack, title: v.title, channel: v.channel },
              artist,
            ) === 'yes')
        )
          yield {
            externalId: v.externalId,
            title: v.title,
            artist: v.artist ?? v.channel,
          };
    }
  }

  private async *byArtist(
    memberId: string,
    artist: Artist,
    mode: Find['mode'],
  ): AsyncGenerator<Candidate> {
    if (mode === 'latest' || mode === 'popular') {
      const { videos, verified } = await findFresh(
        { innertube: this.innertube, search: this.search },
        memberId,
        artist.name,
        mode,
      );
      for (const v of videos)
        yield {
          externalId: v.externalId,
          title: v.title,
          artist: v.channel,
          ...(verified ? { fresh: mode } : {}),
        };
      return;
    }
    for (const s of await this.musicSongs(artist.name, 25))
      if (
        creditsArtist(s.artist, artist, true) &&
        !notTheSong(s.title, '') &&
        (s.durationSec ?? 0) <= MAX_SEC
      )
        yield { externalId: s.externalId, title: s.title, artist: s.artist };
    const { videos } = await findFresh(
      { innertube: this.innertube, search: this.search },
      memberId,
      artist.name,
      'top',
    );
    for (const v of videos)
      yield { externalId: v.externalId, title: v.title, artist: v.channel };
  }

  /** YouTube's own "up next" for the song on air. */
  private async *similar(roomId: string): AsyncGenerator<Candidate> {
    const np = (await this.snapshots.build(roomId))?.nowPlaying?.item.track;
    if (!np) return;
    for (const id of await this.innertube.upNext(np.externalId))
      yield { externalId: id, title: '' };
  }

  /** The AI's picks, each checked on YouTube Music (name and artist must match); then the mood itself. */
  private async *byMood(find: Find): AsyncGenerator<Candidate> {
    for (const p of find.picks ?? []) {
      const artist = await this.resolver.artist(p.artist);
      const hit = (await this.musicSongs(`${p.song} ${p.artist}`, 5)).find(
        (s) =>
          named(s.title, p.song) &&
          creditsArtist(s.artist, artist) &&
          !notTheSong(s.title, p.song),
      );
      if (hit)
        yield {
          externalId: hit.externalId,
          title: hit.title,
          artist: hit.artist,
        };
      else
        this.logger.log(
          `DJ pick not found on YouTube Music: ${p.artist} - ${p.song}`,
        );
    }
    if (find.mood) {
      // "chill" alone finds songs named Chill: "nhạc chill" finds chill music.
      const q = /^(nhac|music|songs?)\b/.test(normalizeQuery(find.mood))
        ? find.mood
        : `nhạc ${find.mood}`;
      for (const s of await this.musicSongs(q, 20))
        if (!notTheSong(s.title, find.mood) && (s.durationSec ?? 0) <= MAX_SEC)
          yield { externalId: s.externalId, title: s.title, artist: s.artist };
    }
  }

  // ------------------------------------------------------------------ YouTube

  private async musicSongs(q: string, max = LOOK_AT): Promise<MusicSong[]> {
    if (!this.innertube.available) return [];
    try {
      return await this.innertube.musicSongs(q, max);
    } catch (e) {
      this.logger.warn(`YouTube Music search "${q}" failed: ${String(e)}`);
      return [];
    }
  }

  /** YouTube videos (InnerTube first, Data API when it rests). */
  private async videos(memberId: string, q: string): Promise<TrackSummary[]> {
    try {
      return (await this.search.search(memberId, q)).results.filter(
        (t) => (t.durationSec ?? 0) <= MAX_SEC,
      );
    } catch (e) {
      this.logger.warn(`DJ video search "${q}" failed: ${String(e)}`);
      return [];
    }
  }
}

const emptyTrack: TrackSummary = {
  id: '',
  provider: 'youtube',
  externalId: '',
  title: '',
  channel: null,
  durationSec: null,
  thumbnailUrl: null,
  artist: null,
  song: null,
};
