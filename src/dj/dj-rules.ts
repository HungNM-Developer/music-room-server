import {
  type DjClarify,
  type GuideTarget,
  type InfoKind,
  normalizeQuery,
  parseYouTubeVideo,
} from '../contracts';
import type { Plan } from './dj-plan';

/**
 * "@DJ" requests the rules understand on their own, without the AI (spec 2026-10-18-dj-chat):
 * how-to questions (the DJ shows the button), questions about the room, a greeting, and
 * "the newest / trending songs of <artist>". Anything else is vague and goes to the AI.
 * Matching runs on the accent-free lower-case text; names are cut from the original words.
 */

export type RuleMatch =
  | { kind: 'guide'; guide: GuideTarget; query?: string }
  | { kind: 'info'; info: InfoKind }
  | { kind: 'hello' }
  | { kind: 'fresh'; artist: string; mode: 'latest' | 'popular' };

/** "@DJ" as a word of its own (not "dj@x.com", not "dj" alone). */
const MENTION = /(^|[\s([{"'“])@dj(?=$|[\s,.:;!?)\]}"'”])/i;
const MENTION_ALL = new RegExp(MENTION.source, 'gi');

/** The request without "@DJ"; null = not addressed to the DJ, '' = only "@DJ". */
export function extractDjRequest(content: string): string | null {
  if (!MENTION.test(content)) return null;
  return content
    .replace(MENTION_ALL, '$1')
    .replace(/^[\s,.:;!?-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words that make a song request vague: the DJ has to choose (AI or a real lookup). */
const VAGUE = [
  'moi',
  'moi nhat',
  'vua ra',
  'trending',
  'hot',
  'thinh hanh',
  'giong',
  'chill',
  'vui',
  'buon',
  'vai bai',
  'may bai',
  'gi do',
  'nao do',
  'bat ky',
  'ngau nhien',
  'random',
  'latest',
  'new',
  'popular',
  'something',
  'some',
  'nhe nhang',
  'soi dong',
  'tam trang',
  'hop',
  'phu hop',
  'nhac',
];

/** VAGUE as written: "giống" (like) is not "Giông" (Ngày Chưa Giông Bão), "mời" is not "mới". */
const VAGUE_ACCENTED = [
  'mới',
  'mới nhất',
  'vừa ra',
  'trending',
  'hot',
  'thịnh hành',
  'giống',
  'chill',
  'vui',
  'buồn',
  'vài bài',
  'mấy bài',
  'gì đó',
  'nào đó',
  'bất kỳ',
  'ngẫu nhiên',
  'random',
  'latest',
  'new',
  'popular',
  'something',
  'some',
  'nhẹ nhàng',
  'sôi động',
  'tâm trạng',
  'hợp',
  'phù hợp',
  'nhạc',
];

/**
 * Vague, judged on the original words: with accents when the asker typed them, otherwise
 * (no accents at all) on the plain form like `vague`.
 */
export function vagueIn(original: string): boolean {
  const lower = original
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const p = plain(original);
  if (lower === p) return vague(p);
  return VAGUE_ACCENTED.some((w) => has(lower, w));
}

/** Accent-free, lower case, punctuation as spaces. Word positions match `words()`. */
export function plain(text: string): string {
  return normalizeQuery(text.replace(/[^\p{L}\p{N}\s'-]/gu, ' '));
}
export function words(text: string): string[] {
  return text
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
function has(text: string, phrase: string): boolean {
  return new RegExp(`(^| )${phrase}( |$)`).test(text);
}
export function vague(text: string): boolean {
  return VAGUE.some((w) => has(text, w));
}

/** Polite words around a request ("giúp tôi", "dùm", "nhé"…), in plain form. */
// Not "cho anh / cho em": they are common in song names ("Hãy Trao Cho Anh").
export const FILLER_END =
  /( (giup|dum|gium) (toi|minh|em|tui)| giup| dum| gium| di| nhe| nha| nhen| please| pls| di nao)+$/;
export const FILLER_START =
  /^((hay|giup|dum|gium|cho) (toi|minh|em|tui) (hoi )?|giup |dum |gium |hay |hoi |lam on |please |pls |ban oi |dj oi )+/;

/** Trailing filler words as written (FILLER_END matches them without accents). */
const FILLER_WORDS = new Set([
  'giúp',
  'dùm',
  'giùm',
  'tôi',
  'mình',
  'em',
  'tui',
  'đi',
  'nhé',
  'nha',
  'nhá',
  'nhen',
  'please',
  'pls',
  'nào',
]);

/** The original words from index `from`, trailing filler removed. */
export function tail(original: string, from: number): string {
  const ws = words(original).slice(from);
  let p = plain(ws.join(' '));
  while (ws.length) {
    // A leading space, so a tail made only of filler ("đi", "giúp tôi") is cut too.
    const cut = (' ' + p).replace(FILLER_END, '').trim();
    if (cut === p) break;
    const drop = p.split(' ').length - cut.split(' ').filter(Boolean).length;
    // With their accents: "nhà" (Một Nhà) is not "nha", "dì" is not "đi".
    if (
      !ws
        .slice(ws.length - drop)
        .every((w) => FILLER_WORDS.has(w.toLowerCase()))
    )
      break;
    // "Chạy Ngay Đi": a capitalised word right after another capitalised one is the title's.
    const at = ws.length - drop;
    const capital = (w?: string) => Boolean(w && w[0] !== w[0].toLowerCase());
    if (capital(ws[at]) && capital(ws[at - 1])) break;
    ws.splice(ws.length - drop, drop);
    p = cut;
  }
  return ws.join(' ').trim();
}

const ADD_VERB =
  /^(bat|them|mo|play|add|phat|cho nghe|nghe|queue|chon|lay|kiem|nhet|dua|xep|order)( (giup|dum|cho) (toi|minh|em|tui)| giup| dum)?( (bai hat|bai|nhac|song))? /;
/** "đưa Lạc Trôi vào hàng chờ": where it goes, not part of the name. */
const INTO_QUEUE = / vao (hang cho|danh sach( phat)?|list|queue|playlist)$/;

/** How-to phrases (the DJ shows the button) in plain form, most specific first. */
const GUIDES: [GuideTarget, RegExp][] = [
  ['wish', /(^| )(loi chuc|gui loi|tang bai|wish)( |$)/],
  ['playlist', /(^| )(playlist|danh sach phat)( |$)/],
  ['itemMenu', /(^| )(ghim|uu tien|go bai|xoa bai|bo bai|pin)( |$)/],
  ['theme', /(^| )(theme|giao dien|chu de|doi mau|hinh nen)( |$)/],
  ['history', /(^| )(lich su|history)( |$)/],
  [
    'settings',
    /(^| )(cai dat|setting|settings|gioi han bai|doi ten phong|xoa phong)( |$)/,
  ],
  ['recap', /(^| )(tong ket|tom tat|recap)( |$)/],
  ['permissions', /(^| )(cap quyen|quyen|permissions?)( |$)/],
  [
    'members',
    /(^| )(thanh vien|nguoi trong phong|ai dang trong phong|members?)( |$)/,
  ],
  ['lang', /(^| )(ngon ngu|tieng anh|english|language)( |$)/],
  ['leave', /(^| )(roi phong|thoat phong|ra khoi phong|leave)( |$)/],
  ['reactions', /(^| )(cam xuc|emoji|reactions?)( |$)/],
  ['djPads', /(^| )(ban dj|hieu ung am thanh|pads?)( |$)/],
  ['djMention', /(^| )(goi dj|hoi dj|dung dj|nho dj)( |$)/],
  ['host', /(^| )(may phat|trang may phat|loa|tv|man hinh loa|host)( |$)/],
  // "chặn bài" only with its accent: "chán bài này" (bored of it) is the same without.
  ['block', /(^| )(chan( mot| 1)? bai|block)( |$)/],
  ['lyrics', /(^| )(loi bai hat|loi bai|xem loi|lyrics?)( |$)/],
  ['listen', /(^| )(nghe cung|listen along)( |$)/],
  ['mini', /(^| )(thu nho|man hinh nho|mini player|mini|pip)( |$)/],
  [
    'share',
    /(^| )(chia se|share|invite|qr|ma qr|ma phong|link phong|moi (nguoi khac|ban|dong nghiep|vao phong))( |$)/,
  ],
  ['pause', /(^| )(tam dung|dung nhac|tat nhac|phat tiep|pause|resume)( |$)/],
  ['heart', /(^| )(tha tim|like bai|like|heart)( |$)/],
  ['save', /(^| )(luu|save|yeu thich|favorite|favourite)( |$)/],
  [
    'skip',
    /(^| )(skip|bo qua|qua bai|next|chuyen bai|bai tiep|bai tiep theo)( |$)/,
  ],
  // The general ones last: "thêm bài vào playlist" is about playlists, not adding.
  ['played', /(^| )(bai da phat|vua phat|da phat)( |$)/],
  ['suggestions', /(^| )(goi y)( |$)/],
  ['chat', /(^| )(nhan tin|chat|tro chuyen)( |$)/],
  ['add', /(^| )(them bai|tim bai|add)( |$)/],
  ['queue', /(^| )(hang cho|queue)( |$)/],
];

const INFOS: [InfoKind, RegExp][] = [
  [
    'nextSong',
    /(^| )(bai (tiep theo|ke tiep|sau) (la|se la)?( bai)? ?(gi|nao)|tiep theo (la|phat) (bai )?(gi|nao)|sap (toi|phat) (la )?bai (gi|nao)|what('s| is) next)( |$)/,
  ],
  [
    'myCount',
    /(^| )(toi|minh|em|tui) (da )?(them|chon|bat) (bao nhieu|may) bai/,
  ],
  [
    'myNext',
    /((bao (nhieu|lau)|may bai|khi nao|bao gio|con (may|bao)).*(cua|toi|den|den luot) (toi|minh|em|tui))|(when.*my (song|turn))|(luot (cua )?(toi|minh))/,
  ],
  [
    'whoPicked',
    /(^| )((ai (chon|them|bat|mo))|cua ai|who (picked|added|chose))( |$)/,
  ],
  [
    'nowPlaying',
    /(^| )(dang phat|bai (gi|nao) (day|vay|the|dang)|bai nay la( bai)? gi|ten bai|now playing|what('s| is) (this|playing))( |$)/,
  ],
  [
    'queueLength',
    /(^| )(hang cho|con (bao nhieu|may) bai|queue|bao nhieu bai (dang )?cho)( |$)/,
  ],
];

/** A task word anywhere in the request. */
const ACTION_INSIDE =
  /(^| )(go|go bo|xoa|tha tim|ghim|skip|bo qua|chuyen|uu tien|tam dung|them|bat|xep|don|luu|save|tao|phat|mo|doi|cho nghe|add|remove|play)( |$)/;

const SIMILAR = /(^| )(giong|tuong tu|na na|nhu bai|similar|like this)( |$)/;
const SIMILAR_ACCENTED =
  /(^| )(giống|tương tự|na ná|như bài|similar|like this)( |$)/;

/** SIMILAR on the words as written when they carry accents ("Giông" is not "giống"). */
function similarIn(original: string, p: string): boolean {
  const lower = original
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return lower === plain(original)
    ? SIMILAR.test(p)
    : SIMILAR_ACCENTED.test(lower);
}

const HELLO =
  /^(hi|hello|hey|chao|xin chao|alo|help|tro giup|giup voi|ban lam (duoc )?gi|lam duoc gi|cam on|thanks|thank you)( |$)/;

/** "(bài) mới / trending của <X>", "<X> có bài (gì) mới". */
const FRESH_POPULAR =
  /(^| )(trending|hot|dang hot|thinh hanh|popular|hit) (cua|of|by) /;
const FRESH_LATEST =
  /(^| )(moi nhat|moi ra|vua ra|moi|latest|new) (cua|of|by) /;
const FRESH_HAS_NEW = /^(.+) co bai( hat)?( gi)? moi/;
/** Not an artist: "hôm nay có bài gì mới", "bạn có bài gì mới". */
const NOT_ARTIST =
  /^(hom nay|dao nay|tuan nay|thang nay|nam nay|gan day|bay gio|hien tai|hien gio|ban|minh|toi|tui|em|anh|chi|phong|ai|nguoi ta|youtube|tiktok)$/;

/** `offset`: words of `original` already cut from the front of `p` (polite words). */
export function freshMatch(
  original: string,
  p: string,
  offset: number,
): Extract<RuleMatch, { kind: 'fresh' }> | null {
  for (const [re, mode] of [
    [FRESH_POPULAR, 'popular'],
    [FRESH_LATEST, 'latest'],
  ] as const) {
    const m = re.exec(p);
    if (!m) continue;
    // The artist: the original words after "của / of / by".
    const before = p
      .slice(0, m.index + m[0].length)
      .trim()
      .split(' ').length;
    const artist = tail(original, offset + before);
    // Trending is tried first: "bài mới trending của X" asks for the trending one.
    if (artist && !vagueIn(artist)) return { kind: 'fresh', artist, mode };
  }
  const m = FRESH_HAS_NEW.exec(p);
  if (m && !NOT_ARTIST.test(m[1]) && !vague(m[1])) {
    const n = m[1].split(' ').length;
    const artist = words(original)
      .slice(offset, offset + n)
      .join(' ');
    if (artist) return { kind: 'fresh', artist, mode: 'latest' };
  }
  return null;
}

/** null = the request is vague: the AI decides. */
export function matchRules(request: string): RuleMatch | null {
  let original = request.trim();
  const into = INTO_QUEUE.exec(' ' + plain(original));
  if (into) {
    const ws = words(original);
    original = ws
      .slice(0, ws.length - into[0].trim().split(' ').length)
      .join(' ');
  }
  const p0 = plain(original);
  if (!p0) return { kind: 'hello' };
  const p = p0.replace(FILLER_START, '');
  const offset = p0.split(' ').length - (p ? p.split(' ').length : 0);
  const guideOk = (g: GuideTarget) =>
    g !== 'block' || /chặn|block/i.test(original);

  const fresh = freshMatch(original, p, offset);
  if (fresh) return fresh;

  // "bài gì giống bài đang phát": a song request, not a question about the song on air.
  if (similarIn(original, p)) return null;

  for (const [info, re] of INFOS)
    if (re.test(p)) {
      // "hàng chờ có bài nào của Lan thì gỡ hết": a task about the queue, not a question.
      if (info === 'queueLength' && ACTION_INSIDE.test(p)) return null;
      return { kind: 'info', info };
    }

  // "mời mọi người": only with the accent ("mọi người" = everyone).
  if (/(^|\s)mời\s+(bạn|mọi người|người|ai|thêm|đồng nghiệp)/i.test(original))
    return { kind: 'guide', guide: 'share' };
  // "nghe cùng", "phát tiếp" start like a song request ("nghe…", "phát…").
  for (const [guide, re] of GUIDES)
    if ((guide === 'listen' || guide === 'pause') && re.test(p))
      return { kind: 'guide', guide };

  // "bật / thêm (bài) <tên>": a clear name is something the asker can search themselves.
  const add = ADD_VERB.exec(p + ' ');
  if (add) {
    // "bật nhạc đi", "thêm bài giúp tôi": nothing but polite words after the verb.
    const rest = (' ' + p.slice(add[0].length).trim())
      .replace(FILLER_END, '')
      .trim();
    const guideOfRest = GUIDES.find(
      ([g, re]) => re.test(rest) && rest.split(' ').length <= 3 && guideOk(g),
    );
    if (guideOfRest) return { kind: 'guide', guide: guideOfRest[0] };
    if (!rest) return { kind: 'guide', guide: 'add' };
    // "bật bài của X", "bật nhạc vui": the DJ has to choose.
    const start = offset + add[0].trim().split(' ').length;
    const query = tail(original, start);
    if (vagueIn(query) || /^(cua|of|by) /.test(rest)) return null;
    return query ? { kind: 'guide', guide: 'add', query } : null;
  }

  for (const [guide, re] of GUIDES)
    if (re.test(p) && guideOk(guide)) return { kind: 'guide', guide };

  if (HELLO.test(p) && p.split(' ').length <= 6) return { kind: 'hello' };
  return null;
}

// ------------------------------------------------------------ quick rules (spec 2026-10-18-dj-translator)

export type QuickMatch =
  | { kind: 'hello' }
  | { kind: 'clarify'; about: DjClarify }
  | { kind: 'info'; info: InfoKind }
  | { kind: 'guide'; guide: GuideTarget }
  | { kind: 'plan'; plan: Plan };

const QUICK_SKIP =
  /^(skip|bo qua|qua bai|next|chuyen bai|doi bai|bai khac|bai tiep( theo)?)( (bai nay|bai|di))?( (\d+) bai)?$/;
/** dj-plan MAX_SKIPS (not imported: dj-plan imports this file). */
const MAX_QUICK_SKIPS = 5;
const QUICK_SKIP_N = /^(skip|bo qua|qua) (\d+) bai$/;
const QUICK_PAUSE =
  /^(tam dung|dung nhac|dung lai|tat nhac|pause|stop)( (nhac|bai nay|lai))?$/;
const QUICK_RESUME =
  /^(phat tiep|tiep tuc( phat)?|resume|bat lai nhac|mo lai nhac|phat lai di)$/;
const QUICK_SAVE = /^(luu|save)( (bai nay|bai dang phat|lai|bai))?$/;
/** A question about how to do something ("làm sao…", "ở đâu", "how"). */
const HOW =
  /(^| )(lam sao|lam the nao|lam cach nao|nhu the nao|the nao|cach nao|cach|o dau|cho nao|bam dau|bam vao dau|nut nao|nut gi|la gi|dung sao|how( do| to| can)?|where)( |$)/;

/**
 * "Làm sao để skip?", "lưu bài ở đâu": a how-to question. The DJ never carries these out, it
 * shows where the button is (spotlight).
 */
export function isHowQuestion(request: string): boolean {
  return HOW.test(plain(request));
}

/** The help topic of a how-to question, from its words (null: the AI decides). */
export function howTopic(request: string): GuideTarget | null {
  const original = request.trim();
  const p = plain(original);
  for (const [guide, re] of GUIDES)
    if (re.test(p) && (guide !== 'block' || /chặn|block/i.test(original)))
      return guide;
  return null;
}

/** "xoá đi", "gỡ bài đi": removing with nothing named. Removing is never a guess: ask. */
const BARE_REMOVE =
  /^(xoa|go|go bo|bo|huy|remove|delete)( (bai|bai hat|no|cai do|di|nha|nhe|luon|giup|dum|gium|toi|minh|em|tui))*$/;
/** "đổi bài này thành Nàng Thơ": "bài này" names no queue song (the AI guessed one). */
const REPLACE_THIS =
  /^(doi|thay|thay the) (bai nay|bai do|bai kia|no|cai nay|cai do) (thanh|bang|sang|qua) /;

/** A YouTube link as a word of the request (bare ids are not taken: they look like words). */
function linkId(word: string): string | null {
  const w = word.replace(/^[("'“‘<[]+|[)"'”’>\].,!?;:]+$/g, '');
  if (!/youtu/i.test(w)) return null;
  return parseYouTubeVideo(w)?.videoId ?? null;
}

/** The videos of the YouTube links in a request, in order (each once). */
export function linksIn(request: string): string[] {
  const ids = request
    .split(/\s+/)
    .map(linkId)
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

/** Around pasted links, only "add it" words: "thêm bài này", "bật giúp tôi", "add". */
const LINK_WORDS =
  /^((them|bat|mo|phat|add|play|cho nghe|nghe|queue)( (giup|dum|gium|cho) (toi|minh|em|tui)| giup| dum| gium)?)?( (bai|video|clip|link|cai) (nay|nhe|nha|di)?)?( (bai|video|clip|link) nay)?( (nay|vao hang cho|vao queue))?$/;

/** "@DJ <link>", "thêm bài này <link>": those videos, nothing else asked. */
function quickLinks(request: string): string[] | null {
  const ids = linksIn(request);
  if (!ids.length) return null;
  let p = plain(
    request
      .split(/\s+/)
      .filter((w) => !linkId(w))
      .join(' '),
  );
  for (;;) {
    const cut = (' ' + p)
      .replace(FILLER_END, '')
      .trim()
      .replace(FILLER_START, '')
      .trim();
    if (cut === p) break;
    p = cut;
  }
  return !p || LINK_WORDS.test(p) ? ids : null;
}

/**
 * "Thêm bài Dấu Mưa vào mục yêu thích", "lưu "Dấu Mưa" vào yêu thích": one named song into the
 * asker's saved songs (Yêu thích), not the queue. The song is taken from the queue when it is
 * there, else looked up on YouTube (dj-combo).
 */
const QUICK_FAVORITE =
  /^(?<verb>them|luu|save|cho|dua|bo)(?<kind> (?:bai hat|bai|ca khuc|song))? (?<title>.+?) (?:vao|trong) (?:muc |danh sach |list )?(?:yeu thich|bai da luu|da luu|favou?rites?)(?: cua (?:toi|minh|em|tui))?$/;

export function quickFavorite(request: string): string | null {
  const original = request.trim().replace(/[?!.。…]+$/, '');
  if (/[,;/&+\n]/.test(original)) return null;
  const p0 = plain(original);
  const p = p0.replace(FILLER_START, '');
  const m = QUICK_FAVORITE.exec((' ' + p).replace(FILLER_END, '').trim());
  if (!m) return null;
  const quoted = QUOTED.exec(original);
  if (quoted) return quoted[1].trim();
  // The title: the original words between the verb (and "bài") and "vào".
  const offset = p0.split(' ').length - (p ? p.split(' ').length : 0);
  const g = m.groups as { verb: string; kind?: string; title: string };
  const start =
    offset +
    g.verb.split(' ').length +
    (g.kind ? g.kind.trim().split(' ').length : 0);
  const title = words(original)
    .slice(start, start + g.title.split(' ').length)
    .join(' ');
  // "lưu bài này vào yêu thích": the song on air, a one-button task (not a lookup).
  return title &&
    !vagueIn(title) &&
    !/^(nay|do|dang phat|bai nay)$/.test(g.title)
    ? title
    : null;
}

/** "thêm / bật / phát (bài) …": the verb that adds one named song. */
const QUICK_ADD =
  /^(them|bat|mo|phat|add|play|cho nghe|order)( (giup|dum|gium|cho) (toi|minh|em|tui)| giup| dum| gium)?( (bai hat|bai|ca khuc|song))? /;
/**
 * Words that make it more than "add this one song" (a second song, a wish, "play it now",
 * "a few", "trending", "mười bài"…): the AI reads those. Checked on the words written in lower case only:
 * in "Có Hẹn Với Thanh Xuân" or "Chạy Ngay Đi" they belong to the title.
 */
const QUICK_ADD_NOT =
  /(^| )(va|voi|roi|kem|tang|chuc|nhan|ngay|luon|sau|truoc|nua|tiep|lai|cung|them|playlist|list|moi|hot|top|trending|thinh hanh|giong|tuong tu|vai|may|mot so|cac|nhung|hay nhat|noi tieng|nghe nhieu|da luu|vua phat|da phat|goi y|nao do|gi|bai|bai hat|nhac|ca khuc|songs?|nhieu|it|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi|chuc|tram|vao|luu|yeu thich|favou?rites?)( |$)/;
/** "… vào hàng chờ": where it goes, not part of the title. */
const QUICK_INTO = / (vao|trong) (hang cho|danh sach phat|queue)$/;
const QUICK_BY = /^(cua|of|by)$/;
/** Quotes around a title: "Từ Đầu", “Từ Đầu”, 'Từ Đầu'. */
const QUOTED = /["“”'‘’«»]([^"“”'‘’«»]+)["“”'‘’«»]/;

/**
 * "Thêm bài "Từ Đầu" của Chillies", "bật Lạc Trôi", "add Waiting For You": one song named by
 * its title (and maybe its artist), nothing else. `members`: "của Lan" names who picked
 * songs when Lan is in the room, so that one goes to the AI.
 */
export function quickAdd(
  request: string,
  members: string[] = [],
): { title: string; artist?: string } | null {
  const original = request.trim().replace(/[?!.。…]+$/, '');
  // "Lạc Trôi, Nàng Thơ", "A / B", "A & B": several songs (or a wish after a comma).
  if (/[,;/&+\n]/.test(original)) return null;
  const p0 = plain(original);
  const p = p0.replace(FILLER_START, '');
  const offset = p0.split(' ').length - (p ? p.split(' ').length : 0);
  const verb = QUICK_ADD.exec(p + ' ');
  if (!verb) return null;
  let ws = words(original).slice(offset + verb[0].trim().split(' ').length);
  const into = QUICK_INTO.exec(' ' + plain(ws.join(' ')));
  if (into) ws = ws.slice(0, ws.length - into[0].trim().split(' ').length);
  const rest = tail(ws.join(' '), 0);
  const restPlain = plain(rest);
  const quoted = QUOTED.exec(original);
  // The words written in lower case; capitalised or quoted ones (a title's) blanked out.
  const inQuotes = new Set(quoted ? words(quoted[1]) : []);
  const lower = words(rest)
    .map((w) => (w === w.toLowerCase() && !inQuotes.has(w) ? plain(w) : '_'))
    .join(' ');
  if (
    !restPlain ||
    restPlain.split(' ').length > 10 ||
    /\d/.test(restPlain) ||
    QUICK_ADD_NOT.test(lower) ||
    /^(cua|of|by) /.test(restPlain) ||
    vagueIn(rest)
  )
    return null;
  const rw = words(rest);
  let title: string;
  let artist: string | undefined;
  if (quoted) {
    title = quoted[1].trim();
    // After the quoted title: nothing, or "của / of / by <artist>".
    let after = words(original.slice(quoted.index + quoted[0].length));
    const intoAfter = QUICK_INTO.exec(' ' + plain(after.join(' ')));
    if (intoAfter)
      after = after.slice(
        0,
        after.length - intoAfter[0].trim().split(' ').length,
      );
    const afterRest = tail(after.join(' '), 0);
    const ap = words(afterRest);
    if (ap.length && !QUICK_BY.test(plain(ap[0]))) return null;
    artist = ap.slice(1).join(' ') || undefined;
    if (ap.length && !artist) return null;
  } else {
    // The artist follows the last "của / of / by" written in lower case: "Em Của Ngày Hôm
    // Qua của Sơn Tùng". A title like "Em Của Ngày Hôm Qua" keeps its capital "Của".
    const lowercaseOnly = rest === rest.toLowerCase();
    let at = -1;
    for (let i = rw.length - 2; i >= 1; i--)
      if (QUICK_BY.test(plain(rw[i])) && rw[i] === rw[i].toLowerCase()) {
        at = i;
        break;
      }
    title = (at >= 0 ? rw.slice(0, at) : rw).join(' ');
    artist = at >= 0 ? rw.slice(at + 1).join(' ') : undefined;
    // "em của ngày hôm qua" typed in lower case: one word before "của" may be the title's.
    if (artist && lowercaseOnly && title.split(' ').length < 2) return null;
  }
  if (!title || vagueIn(title) || (artist && vagueIn(artist))) return null;
  if (
    artist &&
    members.some(
      (m) =>
        plain(m) === plain(artist) || plain(m).startsWith(plain(artist) + ' '),
    )
  )
    return null;
  return artist ? { title, artist } : { title };
}

/**
 * The short, certain requests the DJ handles without the AI: every word must belong to the
 * pattern (polite words aside). Anything left over goes to the AI translator: never a guess.
 */
export function matchQuick(
  request: string,
  members: string[] = [],
): QuickMatch | null {
  // A how-to question is answered by showing the button, never by doing it.
  if (isHowQuestion(request)) {
    const guide = howTopic(request);
    return guide ? { kind: 'guide', guide } : null;
  }
  const original = request.trim().replace(/[?!.。…]+$/, '');
  let p = plain(original);
  if (!p) return { kind: 'hello' };
  for (;;) {
    const cut = (' ' + p)
      .replace(FILLER_END, '')
      .trim()
      .replace(FILLER_START, '')
      .trim();
    if (cut === p || !cut) break;
    p = cut;
  }
  if (BARE_REMOVE.test(p)) return { kind: 'clarify', about: 'removeScope' };
  if (REPLACE_THIS.test(p + ' '))
    return { kind: 'clarify', about: 'whichSong' };
  if (QUICK_SKIP_N.test(p) || QUICK_SKIP.test(p)) {
    const count = Number(/(\d+) bai$/.exec(p)?.[1] ?? 1);
    return {
      kind: 'plan',
      plan: {
        steps: [
          { do: 'skip', count: Math.min(MAX_QUICK_SKIPS, Math.max(1, count)) },
        ],
      },
    };
  }
  if (QUICK_PAUSE.test(p))
    return { kind: 'plan', plan: { steps: [{ do: 'pause' }] } };
  if (QUICK_RESUME.test(p))
    return { kind: 'plan', plan: { steps: [{ do: 'resume' }] } };
  if (QUICK_SAVE.test(p))
    return { kind: 'plan', plan: { steps: [{ do: 'save' }] } };
  const links = quickLinks(request);
  if (links)
    return {
      kind: 'plan',
      plan: { steps: [{ do: 'addLink', videoIds: links }] },
    };
  const fav = quickFavorite(request);
  if (fav)
    return {
      kind: 'plan',
      plan: { steps: [{ do: 'save', target: { titles: [fav], said: fav } }] },
    };
  const add = quickAdd(request, members);
  if (add)
    return {
      kind: 'plan',
      plan: {
        steps: [
          {
            do: 'find',
            find: {
              titles: [add.title],
              ...(add.artist ? { artist: add.artist } : {}),
            },
            count: 1,
          },
        ],
      },
    };
  const short = p.split(' ').length <= 10;
  // A question about the room asks something ("còn mấy bài", "tên gì", "ai chọn"…):
  // "cho cả playlist Chill vào hàng chờ" names the queue but asks nothing.
  const asks =
    request.includes('?') ||
    /(^| )(bao nhieu|may|gi|nao|ai|bao gio|khi nao|bao lau|chua|khong|what('s)?|who|when|how many|how long)( |$)/.test(
      p,
    );
  // A task word outside the question itself ("tôi đã thêm mấy bài" asks, "… thì xoá hết" acts).
  if (short && asks && !similarIn(original, p))
    for (const [info, re] of INFOS)
      if (re.test(p) && !ACTION_INSIDE.test(p.replace(re, ' ')))
        return { kind: 'info', info };
  if (HOW.test(p))
    for (const [guide, re] of GUIDES)
      if (re.test(p) && (guide !== 'block' || /chặn|block/i.test(original)))
        return { kind: 'guide', guide };
  if (HELLO.test(p) && p.split(' ').length <= 6) return { kind: 'hello' };
  return null;
}

/**
 * Slack: the old commands only in their short form (spec table); a natural sentence that
 * merely starts with a command word ("skip giúp tôi bài này") goes to the DJ.
 */
export function isSlackCommand(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const first = t.split(/\s+/)[0].toLowerCase();
  if (first === 'connect' || first === 'disconnect') return true;
  if (/^(skip|now|queue|help|here)[.!?]*$/i.test(t)) return true;
  const add = /^add\s+(.+)$/i.exec(t);
  if (!add) return false;
  const arg = add[1].trim();
  if (parseYouTubeVideo(arg)) return true;
  const p = plain(arg);
  return (
    arg.split(/\s+/).length <= 8 &&
    !vague(p) &&
    !/^(bai |nhac )?(cua|of|by) /.test(p) &&
    // Several songs or a wish ("add Lạc Trôi và Nàng Thơ", "… kèm lời chúc"): the DJ.
    !/[,;]/.test(arg) &&
    !/ (va|roi|kem|tang|loi chuc|loi nhan) /.test(` ${p} `)
  );
}
