import {
  DJ_CLARIFY,
  type DjClarify,
  GUIDE_TARGETS,
  type GuideTarget,
  type InfoKind,
  LIMITS,
} from '../contracts';
import {
  type Find,
  int,
  MAX_SKIPS,
  MAX_SONGS,
  type Plan,
  type PlanStep,
  str,
  strs,
  type Target,
} from './dj-plan';
import type { RoomContext } from './dj-interpret';

/**
 * The AI as a translator (spec 2026-10-18-dj-translator): one "@DJ" sentence → a fixed frame of
 * steps. The AI never picks songs (except checked "mood" picks), never sees the queue and never
 * acts: the server resolves names, finds songs and does each step as the asker.
 */
export const TRANSLATE_SYSTEM = `Bạn dịch câu chat gửi "@DJ" trong phòng nghe nhạc chung (văn phòng Việt Nam) thành JSON hành động. Không chọn bài thay người dùng, không bịa tên bài: chỉ ghi đúng điều họ muốn. Server tự tra YouTube và hàng chờ.
Đầu vào: "asker" = người hỏi, "members" = tên người trong phòng, "nowPlaying" = bài đang phát, "queue" = hàng chờ theo thứ tự phát ("n": 1 = bài kế tiếp), "text" = câu.
Dùng "nowPlaying" / "queue" để hiểu "bài này / bài đang phát", "bài đó", "bài số 3", "bài của Lan", tên bài viết tắt hay gõ sai: khi chỉ một bài trong hàng chờ, ghi đúng tên bài trong "queue" vào "titles" (hoặc "positions"). "bỏ / gỡ bài đang phát" = {"do":"skip"}. Không bịa bài không có trong "queue".
"của X": X là một member → người chọn bài (scope "member"); không phải member → ca sĩ ("artist"). "của tôi/mình/em" → scope "mine".
Trả {"steps":[...]} theo thứ tự người nói. Mỗi bước là một trong:
{"do":"add","find":F,"count":n,"pin"?:"next"|"now","wish"?:"lời chúc"}   thêm bài vào hàng chờ ("thêm", "bật", "mở", "cho", "phát bài")
{"do":"suggest","find":F,"count":n}   chỉ gợi ý, KHÔNG thêm ("gợi ý", "có bài nào", "nên nghe gì")
{"do":"remove"|"heart"|"pin"|"skipTo","target":T}   pin = phát kế tiếp; skipTo = chuyển tới bài đó ngay
{"do":"replace","target":T,"find":F}   đổi bài A trong hàng chờ thành bài B; A phải có TÊN bài hoặc SỐ thứ tự người dùng nêu ("bài này", "bài đó" → clarify "whichSong")
{"do":"skip","count"?:n} {"do":"pause"} {"do":"resume"}
{"do":"save","target"?:T}   lưu vào "bài đã lưu": không có target = bài đang phát; "lưu (tất cả / các) bài trong hàng chờ / của Lan…" → target
{"do":"playlistSave","playlist":"tên","target"?:T}   lưu vào playlist: bài đang phát, hoặc các bài trong hàng chờ (target)
{"do":"playlistCreate","name":"tên","find"?:F,"count"?:n}   tạo playlist (có thể kèm bài)
{"do":"playlistPlay","playlist":"tên"}   đưa cả playlist vào hàng chờ
{"do":"info","about":"now"|"next"|"who_picked"|"when_mine"|"queue"|"mine"}   hỏi về phòng ("next" = bài kế tiếp là bài gì)
{"do":"guide","topic":${GUIDE_TARGETS.map((g) => `"${g}"`).join('|')}}   hỏi CÁCH dùng ("làm sao", "ở đâu")
{"do":"clarify","about":"removeScope"|"whichSong"|"whichPlaylist"}   câu mơ hồ (xoá mà không rõ bài nào…)
{"do":"chat","reply":"..."}   chào hỏi / không liên quan tới nhạc
F = {"titles"?:["tên bài họ nêu"],"artist"?:"ca sĩ","mode"?:"top"|"latest"|"popular"|"similar_now"|"mood","mood"?:"tâm trạng/thể loại","picks"?:[{"artist","song"}],"exclude"?:{"titles"?:[...],"artist"?:"..."},"source"?:"saved"|"played"}
  "source": "saved" = bài người hỏi đã lưu, "played" = bài phòng vừa phát ("bật lại", "thêm lại").
  "latest" = mới nhất / vừa ra; "popular" = hot / trending; "similar_now" = giống bài đang phát; "mood" = theo tâm trạng / thể loại ("chill", "buồn", "lofi", "nhạc Hàn"…): LUÔN đặt "mode":"mood" và "picks" 5 bài CÓ THẬT, nổi tiếng, đúng ca sĩ gốc (câu tiếng Việt thì ưu tiên nhạc Việt). "đừng thêm X" → "exclude".
T = {"scope":"all"|"mine"|"others"|"member","member"?:"tên","artist"?:"...","titles"?:[...],"positions"?:[1 = bài kế, -1 = bài cuối],"first"?:n,"last"?:n,"keep"?:{"artist"?:"...","titles"?:[...],"member"?:"..."}}
  "chừa", "giữ lại", "trừ", "ngoại trừ", "để lại" → "keep". "N bài cuối" → "last":N; "bài cuối" → "positions":[-1].
count: thêm mặc định 1, gợi ý mặc định 3; "vài/mấy" = 3; "nhiều" = 5; xin hơn 5 thì ghi đúng số xin.
"reply" (chỉ với "chat"): MỘT câu ngắn (dưới 160 ký tự), hài hước, thân thiện, hợp văn phòng, cùng ngôn ngữ với "text", mỗi lần một kiểu khác nhau, có thể lái về âm nhạc. Không chính trị, tôn giáo, tình dục, xúc phạm, không lời khuyên y tế / tài chính.`;

export function translateInput(room: RoomContext, text: string): string {
  return JSON.stringify({
    asker: room.asker,
    members: room.members,
    nowPlaying: room.nowPlaying,
    queue: room.queue.map((q, i) => ({ n: i + 1, ...q })),
    text,
  });
}

export type Translation =
  | { kind: 'plan'; plan: Plan }
  | { kind: 'info'; info: InfoKind }
  | { kind: 'guide'; guide: GuideTarget }
  | { kind: 'clarify'; about: DjClarify }
  | { kind: 'chat'; reply: string | null };

/** Songs a suggestion offers at least. */
const SUGGEST_MIN = 3;

/** Small talk the AI may write (spec: one short line). */
export const CHAT_REPLY_MAX = 200;

const INFO_OF: Record<string, InfoKind> = {
  now: 'nowPlaying',
  who_picked: 'whoPicked',
  when_mine: 'myNext',
  next: 'nextSong',
  queue: 'queueLength',
  mine: 'myCount',
};

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function picksIn(v: unknown): { artist: string; song: string }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((p) => {
      const o = obj(p);
      const artist = str(o?.artist, 100);
      const song = str(o?.song, 150);
      return artist && song ? { artist, song } : null;
    })
    .filter((p): p is { artist: string; song: string } => p !== null)
    .slice(0, MAX_SONGS);
  return out.length ? out : undefined;
}

function findIn(v: unknown): Find | null {
  const o = obj(v);
  if (!o) return null;
  const titles = strs(o.titles, MAX_SONGS);
  const artist = str(o.artist, 100);
  const mode =
    o.mode === 'top' ||
    o.mode === 'latest' ||
    o.mode === 'popular' ||
    o.mode === 'similar_now' ||
    o.mode === 'mood'
      ? o.mode
      : undefined;
  const mood = str(o.mood, 100);
  // "vài bài chill": a mood alone is a mood request, with or without "mode".
  const moody = mode === 'mood' || (!mode && Boolean(mood));
  const picks = moody ? picksIn(o.picks) : undefined;
  const ex = obj(o.exclude);
  const exTitles = strs(ex?.titles, 10);
  const exArtist = str(ex?.artist, 100);
  const f: Find = {
    ...(titles ? { titles } : {}),
    ...(artist ? { artist } : {}),
    ...(mode ? { mode } : moody ? { mode: 'mood' as const } : {}),
    ...(mood ? { mood } : {}),
    ...(picks ? { picks } : {}),
    ...(exTitles || exArtist
      ? {
          exclude: {
            ...(exTitles ? { titles: exTitles } : {}),
            ...(exArtist ? { artist: exArtist } : {}),
          },
        }
      : {}),
  };
  // Something to look for: names, an artist, the song on air or a mood.
  return titles || artist || mode === 'similar_now' || mood || picks ? f : null;
}

/** A queue target; null when it names no songs at all ("xoá bớt đi"). */
function targetOf(v: unknown): Target | null {
  const o = obj(v);
  if (!o) return null;
  const member = str(o.member, 100);
  const artist = str(o.artist, 100);
  const titles = strs(o.titles, 10);
  const positions = Array.isArray(o.positions)
    ? o.positions
        .filter(
          (n): n is number =>
            typeof n === 'number' &&
            Number.isInteger(n) &&
            n !== 0 &&
            Math.abs(n) <= 50,
        )
        .slice(0, 20)
    : [];
  // 0 or negative is malformed: dropped, not read as 1.
  const first =
    typeof o.first === 'number' && o.first >= 1 ? int(o.first, 50) : undefined;
  const last =
    typeof o.last === 'number' && o.last >= 1 ? int(o.last, 50) : undefined;
  const k = obj(o.keep);
  const keepArtist = str(k?.artist, 100);
  const keepTitles = strs(k?.titles, 10);
  const keepMember = str(k?.member, 100);
  const scope = o.scope;
  const t: Target = {
    ...(scope === 'all' ? { all: true } : {}),
    ...(scope === 'mine' ? { mine: true } : {}),
    ...(scope === 'others' ? { others: true } : {}),
    ...(scope === 'member' && member ? { by: member } : {}),
    ...(artist ? { artist } : {}),
    ...(titles ? { titles } : {}),
    ...(positions.length ? { positions } : {}),
    ...(first ? { first } : {}),
    ...(last ? { last } : {}),
    ...(keepArtist || keepTitles || keepMember
      ? {
          keep: {
            ...(keepArtist ? { artist: keepArtist } : {}),
            ...(keepTitles ? { titles: keepTitles } : {}),
            ...(keepMember ? { member: keepMember } : {}),
          },
        }
      : {}),
  };
  // A place that was given but makes no sense ("last": 0, "positions": [0]): the whole target
  // is malformed. Dropping only the place would widen it (all my songs instead of the last).
  const badPlace =
    (o.first !== undefined && !first) ||
    (o.last !== undefined && !last) ||
    (Array.isArray(o.positions) && o.positions.length > 0 && !positions.length);
  if (badPlace) return null;
  const names =
    t.all ||
    t.mine ||
    t.others ||
    t.by ||
    t.artist ||
    t.titles ||
    t.positions ||
    t.first ||
    t.last;
  return names ? t : null;
}

/** The AI's answer, checked step by step (spec "Luồng xử lý" 3). Never throws. */
export function parseTranslation(raw: unknown): Translation {
  const steps = obj(raw)?.steps;
  if (!Array.isArray(steps) || !steps.length)
    return { kind: 'chat', reply: null };
  const out: PlanStep[] = [];
  let wish: string | undefined;
  let single: Translation | null = null;
  for (const r of steps.slice(0, 10)) {
    const s = obj(r);
    if (!s) continue;
    const pin = s.pin === 'next' || s.pin === 'now' ? s.pin : undefined;
    const asked =
      typeof s.count === 'number' && s.count > MAX_SONGS
        ? { asked: Math.round(s.count) }
        : {};
    switch (s.do) {
      case 'add':
      case 'suggest': {
        // "Thêm mấy bài tôi đã lưu", "bật lại 3 bài vừa phát": from the asker's library.
        const source = obj(s.find)?.source;
        if (s.do === 'add' && (source === 'saved' || source === 'played')) {
          out.push({
            do: 'addFrom',
            source,
            count: int(s.count, MAX_SONGS) ?? 1,
            ...(pin ? { pin } : {}),
            ...asked,
          });
          break;
        }
        const find = findIn(s.find);
        if (!find) break;
        const asked1 = int(s.count, MAX_SONGS);
        // A suggestion is a short list: at least SUGGEST_MIN songs to choose from.
        const count =
          s.do === 'suggest'
            ? Math.max(SUGGEST_MIN, asked1 ?? SUGGEST_MIN)
            : (asked1 ?? find.titles?.length ?? 1);
        out.push({
          do: 'find',
          find,
          count,
          ...(s.do === 'suggest' ? { suggest: true } : {}),
          ...(pin ? { pin } : {}),
          ...asked,
        });
        if (s.do === 'add' && !wish) wish = str(s.wish, LIMITS.wish);
        break;
      }
      case 'remove':
      case 'heart':
      case 'pin':
      case 'skipTo': {
        const target = targetOf(s.target);
        // Removing with no clear scope: ask, never guess (spec "Thất bại").
        if (!target) {
          if (s.do === 'remove')
            return { kind: 'clarify', about: 'removeScope' };
          break;
        }
        if (s.do === 'remove' || s.do === 'heart')
          out.push({ do: s.do, target });
        else out.push({ do: 'pin', target, now: s.do === 'skipTo' });
        break;
      }
      case 'replace': {
        const target = targetOf(s.target);
        const find = findIn(s.find);
        if (target && find) out.push({ do: 'replaceWith', target, find });
        break;
      }
      case 'skip':
        out.push({ do: 'skip', count: int(s.count, MAX_SKIPS) ?? 1 });
        break;
      case 'pause':
      case 'resume':
        out.push({ do: s.do });
        break;
      case 'save': {
        // Saving takes nothing away: a malformed target only falls back to the song on air.
        const target = s.target === undefined ? null : targetOf(s.target);
        out.push(target ? { do: 'save', target } : { do: 'save' });
        break;
      }
      case 'playlistSave': {
        const playlist = str(s.playlist, 100);
        const target = s.target === undefined ? null : targetOf(s.target);
        if (playlist)
          out.push(
            target
              ? { do: 'playlistSave', playlist, target }
              : { do: 'playlistSave', playlist },
          );
        break;
      }
      case 'playlistPlay': {
        const playlist = str(s.playlist, 100);
        if (playlist) out.push({ do: s.do, playlist });
        break;
      }
      case 'playlistCreate': {
        const name = str(s.name, 100);
        if (!name) break;
        const find = findIn(s.find);
        out.push({
          do: 'playlistCreate',
          name,
          ...(find ? { find, count: int(s.count, MAX_SONGS) ?? 1 } : {}),
        });
        break;
      }
      case 'info': {
        const info = typeof s.about === 'string' ? INFO_OF[s.about] : undefined;
        if (info) single ??= { kind: 'info', info };
        break;
      }
      case 'guide':
        if ((GUIDE_TARGETS as readonly unknown[]).includes(s.topic))
          single ??= { kind: 'guide', guide: s.topic as GuideTarget };
        break;
      case 'clarify':
        single ??= {
          kind: 'clarify',
          about: (DJ_CLARIFY as readonly unknown[]).includes(s.about)
            ? (s.about as DjClarify)
            : 'whichSong',
        };
        break;
      case 'chat': {
        // Not cut here: a reply over CHAT_REPLY_MAX gets one of the DJ's own lines instead.
        const reply = str(s.reply, 2000);
        single ??= { kind: 'chat', reply: reply ?? null };
        break;
      }
    }
  }
  // Tasks win over a question or small talk mixed in with them.
  if (out.length)
    return { kind: 'plan', plan: { steps: out, ...(wish ? { wish } : {}) } };
  return single ?? { kind: 'chat', reply: null };
}
