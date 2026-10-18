import { normalizeQuery } from '../contracts';
import type {
  FoundVideo,
  InnerTubeProvider,
} from '../music/innertube.provider';
import type { SearchService } from '../music/search.service';

/** Songs, not clips: one to ten minutes. */
const MIN_SEC = 60;
const MAX_SEC = 600;
const LOOK_AT = 20;
/** Titles that are not the song itself. */
// "Album TAM THÁI TỬ - Track No.4" is a song of an album: only "full album" is not one.
const NOT_A_SONG =
  /\b(reaction|react|live|concert|hop bao|full album|tong hop|playlist|karaoke|cover|lyrics?|loi bai hat|beat|instrumental|remix|mashup|teaser|trailer|behind the scenes|bts|vlog|interview|shorts?|fan ?made|fanmade|ai visual)\b/;

/**
 * "Bài mới / trending của <artist>" (spec 2026-10-18-dj-chat): the free AI has no live data,
 * so YouTube is asked for real. `verified` = InnerTube answered with the date / popularity
 * filters; false = a plain search fallback, which the DJ must not call "newest".
 */
export async function findFresh(
  deps: { innertube: InnerTubeProvider; search: SearchService },
  memberId: string,
  artist: string,
  /** top: the artist's best-known songs, any year ("vài bài của Thùy Chi"). */
  mode: 'latest' | 'popular' | 'top',
  /**
   * Other names of the artist, normalised (DjResolver: "jack - j97", "jack", "j97"): their
   * official channel may carry only one of them ("J97").
   */
  aliases: string[] = [],
): Promise<{ videos: FoundVideo[]; verified: boolean }> {
  const names = [
    ...new Set(
      [normalizeQuery(artist), ...aliases].filter((n) => n.length >= 2),
    ),
  ];
  if (deps.innertube.available) {
    try {
      const tries =
        mode === 'latest'
          ? [
              { upload_date: 'month' as const },
              { upload_date: 'year' as const },
            ]
          : mode === 'popular'
            ? [
                {
                  upload_date: 'year' as const,
                  prioritize: 'popularity' as const,
                },
              ]
            : [{ prioritize: 'popularity' as const }];
      for (const filters of tries) {
        const { videos } = await deps.innertube.search(
          `${artist} MV`,
          LOOK_AT,
          filters,
        );
        const songs = rank(videos, artist, names);
        if (songs.length) return { videos: songs, verified: true };
      }
      return { videos: [], verified: true };
    } catch {
      // InnerTube failing: the plain search below.
    }
  }
  const { results } = await deps.search.search(
    memberId,
    mode === 'top' ? artist : `${artist} mới nhất`,
  );
  return {
    videos: rank(
      results.map((t) => ({
        externalId: t.externalId,
        title: t.title,
        channel: t.channel,
        durationSec: t.durationSec,
        thumbnailUrl: t.thumbnailUrl,
      })),
      artist,
      names,
    ),
    verified: false,
  };
}

/** A channel name as plain words: "Sơn Tùng M-TP Official" → "son tung m tp official". */
function words(t: string): string {
  return normalizeQuery(t)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Song-like videos from the artist's own channel: its name is theirs, alone or with "Official",
 * "Vevo", "- Topic"… ("Đen Vâu Official" yes, "Anh Áo Đen" no). Their own channel first, in
 * YouTube's order (date / popularity). `names`: the artist's names.
 */
function rank(
  videos: FoundVideo[],
  artist: string,
  names: string[],
): FoundVideo[] {
  const forms = [...new Set([artist, ...names].map(words).filter(Boolean))];
  const own = (channel: string | null) => {
    const ch = words(channel ?? '');
    return forms.some((n) =>
      new RegExp(
        `^${escape(n)}( (official|offical|vevo|topic|music|channel|tv|entertainment|s))*$`,
        'u',
      ).test(ch),
    );
  };
  return videos.filter((v) => {
    const sec = v.durationSec ?? 0;
    if (sec < MIN_SEC || sec > MAX_SEC) return false;
    if (NOT_A_SONG.test(normalizeQuery(v.title))) return false;
    return own(v.channel);
  });
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
