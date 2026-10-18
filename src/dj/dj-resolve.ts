import { Injectable, Logger } from '@nestjs/common';
import {
  normalizeQuery,
  type QueueItemView,
  type TrackSummary,
} from '../contracts';
import type { Member } from '../generated/prisma/client';
import { InnerTubeProvider } from '../music/innertube.provider';
import type { Target } from './dj-plan';

/**
 * Names the AI translator passes on, made concrete (spec 2026-10-18-dj-translator, "Giải nghĩa"):
 * an artist as YouTube Music names it, and the queue songs a target means. Removing never
 * guesses: a song whose artist is not certain is kept.
 */

export interface Artist {
  /** YouTube Music's name when found ("Jack - J97"), else what the user typed. */
  name: string;
  /** Normalised names that mean this artist: the full name, what was typed, and its parts. */
  aliases: string[];
  /** Only the full name and what was typed: "Jack" alone may be someone else (Jack Harlow). */
  strict: string[];
  /** Found on YouTube Music. */
  verified: boolean;
}

const CACHE_MS = 24 * 60 * 60_000;
const CACHE_MAX = 500;

/** "Jack - J97", "Sơn Tùng M-TP & Snoop Dogg": the name and each part, normalised. */
export function aliasesOf(...names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const whole = normalizeQuery(n);
    if (whole.length >= 2) out.add(whole);
    for (const part of whole.split(
      /\s+-\s+|\s*&\s*|\s*,\s*|\s+(?:ft\.?|feat\.?|x)\s+/,
    ))
      if (part.trim().length >= 2) out.add(part.trim());
  }
  return [...out];
}

/** `alias` as whole words of `text` (both normalised). */
function holds(text: string, alias: string): boolean {
  const t = ` ${text.replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const a = alias.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return Boolean(a) && t.includes(` ${a} `);
}

/**
 * A credited artist line (YouTube Music's "RHYDER, Coolkid, BAN") names this artist. `strict`:
 * one credited artist IS them ("Wave Rhyder" is not RHYDER); loose: their name as words.
 */
export function creditsArtist(
  credits: string,
  a: Artist,
  strict = false,
): boolean {
  const c = normalizeQuery(credits);
  if (!strict) return a.aliases.some((al) => holds(c, al));
  const each = c
    .split(/\s*,\s*|\s+&\s+|\s+x\s+|\s+(?:ft\.?|feat\.?)\s+/)
    .map((x) => x.replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
  const names = a.strict.map((n) => n.replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
  return each.some((x) => names.includes(x));
}

/**
 * The artist side of a video title: before " - " ("Đen x JustaTee - Đi Về Nhà"), else the parts
 * after the first " | " ("HOA VÔ SẮC | ICM x JACK | OFFICIAL MV"). Empty for a bare song name:
 * "Đen Đá Không Đường" names a song, not the artist Đen.
 */
function creditPart(title: string): string {
  const t = normalizeQuery(title);
  const dash = t.search(/\s[-–]\s/);
  if (dash > 0) return t.slice(0, dash);
  const parts = t.split(/\s*\|\s*/);
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
}

/**
 * Is this song by the artist? Decided by its known artist and its channel; the title counts only
 * on its artist side ("<artist> - <song>"). `no` when its known artist is someone else (`unsure`
 * when, loosely, the title still names them); `unsure` when the artist is not known yet.
 */
export function artistMatch(
  track: TrackSummary,
  a: Artist,
  strict = false,
): 'yes' | 'no' | 'unsure' {
  const names = strict ? a.strict : a.aliases;
  const hit = (f: string | null) =>
    Boolean(f) && names.some((al) => holds(normalizeQuery(f!), al));
  if (hit(track.artist) || hit(track.channel)) return 'yes';
  const titled = hit(creditPart(track.title));
  // Known artist, someone else ("Đen Đá Không Đường" by AMEE): not theirs.
  if (track.artist) return titled && !strict ? 'unsure' : 'no';
  return titled ? 'yes' : 'unsure';
}

/** The song name as whole words of the title (positive filters: "Em" is not "Them Changes"). */
function titleMatch(track: TrackSummary, title: string): boolean {
  const q = normalizeQuery(title);
  return Boolean(q) && holds(normalizeQuery(track.title), q);
}

/** Loose (keeping): the name anywhere in the title. Keeping too much is safe. */
function titleNear(track: TrackSummary, title: string): boolean {
  const q = normalizeQuery(title);
  return Boolean(q) && normalizeQuery(track.title).includes(q);
}

/** The picker by name: the same name, or the name as whole words ("An" is not "Lan"). */
function memberMatch(item: QueueItemView, name: string): boolean {
  const who = normalizeQuery(name);
  const picker = normalizeQuery(item.addedBy?.displayName ?? '');
  return Boolean(who) && (picker === who || holds(picker, who));
}

/**
 * The queue songs a target means, in queue order (spec "Xoá / tim / ghim / chuyển"): whose →
 * by artist (certain only) → titles → minus what is kept (an uncertain artist is kept) → place.
 * `kept`: songs in scope that were kept; `unsure`: how many of them only for being uncertain.
 */
export function selectTargets(
  queue: QueueItemView[],
  t: Target,
  me: Member,
  artists: { artist?: Artist; keep?: Artist },
): { items: QueueItemView[]; kept: QueueItemView[]; unsure: number } {
  let items = queue;
  if (t.mine) items = items.filter((q) => q.addedBy?.id === me.id);
  if (t.others) items = items.filter((q) => q.addedBy?.id !== me.id);
  if (t.by) items = items.filter((q) => memberMatch(q, t.by!));
  if (artists.artist)
    items = items.filter(
      // Removing / hearting by artist: the full name only ("Jack" alone may be Jack Harlow).
      (q) => artistMatch(q.track, artists.artist!, true) === 'yes',
    );
  if (t.titles?.length)
    items = items.filter((q) =>
      t.titles!.some((title) => titleMatch(q.track, title)),
    );
  const kept: QueueItemView[] = [];
  let unsure = 0;
  const k = t.keep;
  const except = t.except ?? [];
  if (k || except.length)
    items = items.filter((q) => {
      let keep = false;
      if (artists.keep) {
        const m = artistMatch(q.track, artists.keep);
        if (m === 'unsure') unsure++;
        keep = m !== 'no';
      }
      keep ||= Boolean(k?.titles?.some((title) => titleNear(q.track, title)));
      keep ||= Boolean(k?.member && memberMatch(q, k.member));
      keep ||= except.some((title) => titleNear(q.track, title));
      if (keep) kept.push(q);
      return !keep;
    });
  if (t.positions?.length) {
    const all = items;
    items = [
      ...new Set(
        t.positions
          .map((n) => all[n > 0 ? n - 1 : all.length + n])
          .filter((q): q is QueueItemView => Boolean(q)),
      ),
    ];
  }
  if (t.first) items = items.slice(0, t.first);
  if (t.last) items = items.slice(-t.last);
  return { items, kept, unsure };
}

/** Artist names resolved on YouTube Music, remembered for a day. */
@Injectable()
export class DjResolver {
  private readonly logger = new Logger(DjResolver.name);
  private readonly cache = new Map<string, { at: number; artist: Artist }>();

  constructor(private readonly innertube: InnerTubeProvider) {}

  async artist(said: string): Promise<Artist> {
    const key = normalizeQuery(said);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.artist;
    let found: { name: string } | null = null;
    let looked = false;
    if (this.innertube.available)
      try {
        found = await this.innertube.musicArtist(said);
        looked = true;
      } catch (e) {
        this.logger.warn(`artist lookup "${said}" failed: ${String(e)}`);
      }
    const artist: Artist = found
      ? {
          name: found.name,
          aliases: aliasesOf(found.name, said),
          strict: [normalizeQuery(found.name), key],
          verified: true,
        }
      : {
          name: said,
          aliases: aliasesOf(said),
          strict: [key],
          verified: false,
        };
    // A failed lookup is not remembered: the next request tries again.
    if (looked) {
      if (this.cache.size >= CACHE_MAX)
        this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, { at: Date.now(), artist });
    }
    return artist;
  }
}
