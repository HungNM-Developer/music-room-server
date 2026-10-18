import { LIMITS } from '../contracts';
import {
  FILLER_START,
  freshMatch,
  plain,
  tail,
  vagueIn,
  words,
} from './dj-rules';

/**
 * "@DJ" requests that hold several tasks (spec 2026-10-18-dj-chat, combos): the DJ does them
 * itself, in order, as the asker. A single task the asker can do stays a guide (dj-rules).
 * Matching runs on the accent-free text; names and titles are cut from the original words.
 * What the words here miss goes to the AI, which answers with the same steps (planFromAi).
 */

export type Pin = 'next' | 'now';

/**
 * Which queue songs. Filters first (the asker's, someone's, by title…), then the place in what
 * is left: `positions` 1-based (1 = the next song; -1 = the last), or the first / last few.
 */
export interface Target {
  all?: boolean;
  mine?: boolean;
  /** Everyone's but the asker's. */
  others?: boolean;
  by?: string;
  titles?: string[];
  except?: string[];
  positions?: number[];
  first?: number;
  last?: number;
  /** As asked, for "not found". */
  said?: string;
  /** Songs by this artist (resolved to YouTube Music's name before matching). */
  artist?: string;
  /** Kept out of the matches ("trừ / chừa bài của J97"). */
  keep?: { artist?: string; titles?: string[]; member?: string };
}

/** Songs to look for on YouTube (the AI translator's "find"; dj-find). */
export interface Find {
  titles?: string[];
  artist?: string;
  mode?: 'top' | 'latest' | 'popular' | 'similar_now' | 'mood';
  mood?: string;
  /** mode "mood" only: songs the AI named, each checked on YouTube Music before use. */
  picks?: { artist: string; song: string }[];
  exclude?: { titles?: string[]; artist?: string };
}

export type PlanStep =
  | { do: 'add'; titles: string[]; pin?: Pin }
  | {
      do: 'addArtist';
      artist: string;
      count: number;
      mode: 'top' | 'latest' | 'popular';
      pin?: Pin;
      /** More songs were asked for than MAX_SONGS. */
      asked?: number;
    }
  | { do: 'addVague'; text: string; count: number; pin?: Pin; asked?: number }
  | {
      do: 'addFrom';
      source: 'played' | 'saved';
      count: number;
      pin?: Pin;
      asked?: number;
    }
  /** Songs the AI chose ("vài bài chill" read by the AI planner). */
  | { do: 'addPicks'; picks: { artist: string; song: string }[]; pin?: Pin }
  | { do: 'heart'; target: Target }
  | { do: 'remove'; target: Target }
  /** A queue song next ("ghim"), or now ("chuyển sang / skip đến"); not queued yet: added. */
  | { do: 'pin'; target: Target; now?: boolean }
  | { do: 'replace'; from: string; to: string }
  | { do: 'skip'; count?: number }
  | { do: 'pause' }
  | { do: 'resume' }
  /** The AI translator's add / suggest: songs found by DjFinder. */
  | {
      do: 'find';
      find: Find;
      count: number;
      suggest?: boolean;
      pin?: Pin;
      asked?: number;
    }
  /** "Đổi bài A thành B": A from the queue, B found on YouTube. */
  | { do: 'replaceWith'; target: Target; find: Find }
  | { do: 'save' }
  | { do: 'playlistSave'; playlist: string }
  | { do: 'playlistCreate'; name: string; find?: Find; count?: number }
  | { do: 'playlistPlay'; playlist: string };

export interface Plan {
  steps: PlanStep[];
  /** Sent with the first song added. */
  wish?: string;
}

/** Songs one "add" may bring at most ("vài bài" = 3, "nhiều bài" = 5). */
export const MAX_SONGS = 5;
const SOME = 3;
/** Songs one "bỏ qua N bài" may skip. */
export const MAX_SKIPS = 5;

type Verb =
  | 'add'
  | 'addAgain'
  | 'heart'
  | 'remove'
  | 'pin'
  | 'replace'
  | 'skip'
  | 'pause'
  | 'resume';

/** Most specific first: "phát tiếp" is resume, "bỏ qua" skip, before "phát" / "bỏ". */
const VERBS: [Verb, RegExp][] = [
  [
    'resume',
    /^(phat tiep|tiep tuc phat|tiep tuc|(bat|mo|phat) lai nhac|resume|unpause)( |$)/,
  ],
  [
    'pause',
    /^(tam dung|tam ngung|dung nhac|dung lai|dung bai|ngung nhac|tat nhac|tat bai|tat(?! ca)|pause|stop)( |$)/,
  ],
  [
    'skip',
    /^(skip|bo qua|qua bai|chuyen bai|chuyen|nhay|next|sang bai|cho qua|jump)( |$)/,
  ],
  [
    'heart',
    /^(tha tim|tha tym|tha mot tim|tha 1 tim|like|love|heart)( cho)?( |$)/,
  ],
  [
    'pin',
    /^(ghim|uu tien|day|dua|keo|pin|bump|prioritize)( (len dau|len truoc|len tren|phat tiep theo|len|up))?( |$)/,
  ],
  [
    'remove',
    /^(go bo|go|xoa bo|xoa|rut|loai bo|loai|huy|don dep|don|bo|clear|remove|delete|del)( |$)/,
  ],
  ['replace', /^(doi|thay)( |$)/],
  [
    'addAgain',
    /^(bat lai|phat lai|mo lai|nghe lai|them lai|cho nghe lai)( |$)/,
  ],
  [
    'add',
    /^(bat|them|mo|phat|cho nghe|nghe|play|add|queue|xep|chon|lay|kiem|tim|nhet|bo sung|order|request|pick|choose|get|find|put on|((toi|minh|em|tui) )?(muon|can|dang muon|rat muon)( (nghe|them|bat|mo|phat|co))?)( |$)/,
  ],
];

/** Polite words right after the verb: "thêm giúp tôi", "bật cho mình". */
const AFTER_VERB =
  /^((giup|dum|gium|cho) (toi|minh|em|tui|anh|chi) |giup |dum |gium )/;

const SEP =
  /\s*[,;•]\s*|\s+(?:và|rồi|sau đó|sau đấy|tiếp đó|tiếp đến|đồng thời|xong rồi|xong|với cả|với lại|cùng với|với|&|\+|and|then)\s+/iu;
/** "1. Lạc Trôi 2) Nàng Thơ": a numbered list is a list. */
const LIST_NUMBER = /(^|\s)\d{1,2}[.)]\s+/gu;

const NUMBERS: Record<string, number> = {
  mot: 1,
  hai: 2,
  ba: 3,
  bon: 4,
  tu: 4,
  nam: 5,
  sau: 6,
  bay: 7,
  tam: 8,
  chin: 9,
  muoi: 10,
};
const NUM = '(\\d{1,3}|mot|hai|ba|bon|tu|nam|sau|bay|tam|chin|muoi)';
/** "nhiều" / "một loạt" = as many as one request may; "vài" = a few. */
const MANY = '(nhieu|rat nhieu|mot loat|ca loat|mot chuc|chuc)';
const FEW = '(vai|mot vai|vai ba|dam ba|may|mot so|mot it|it|cac|nhung)';
// "bài nhạc Trịnh": "nhạc" stays with what follows (it says what kind).
const UNIT = '(bai hat|bai|ban|ca khuc|track|tracks|songs?)';
const COUNT = new RegExp(
  `^(top ${NUM}|${NUM}|${MANY}|${FEW}) ${UNIT}( nua)?( |$)`,
);
const TOP_ONLY = new RegExp(`^top ${NUM}( |$)`);
const MANY_WORD = new RegExp(`^${MANY}$`);
const FEW_WORDS = new RegExp(`^${FEW}$`);
const ONE = /^(bai hat|bai|ca khuc|song) /;

const PIN_NOW =
  /( |^)(ngay bay gio|ngay luc nay|ngay lap tuc|luon bay gio|lien bay gio|phat ngay|bat ngay|phat lien|ngay lien|luon|lien|ngay)$/;
const PIN_NEXT =
  /( |^)(ngay sau bai nay|sau bai nay|tiep theo|ke tiep|len dau hang cho|len dau|dau tien|phat tiep theo)$/;

const PLAYED = /^(vua phat|luc nay|vua roi|da phat|hoi nay|truoc do)( |$)/;
const SAVED =
  /^((nhung|cac) )?(bai )?((toi|minh|em|tui) )?(da )?(luu|yeu thich|thich)( |$)/;
const BY = /^(nhac |bai |bai hat |ca khuc )?(cua|of|by) /;
/** "hot nhất / hay nhất / top của X": the artist's best known songs. */
const BEST =
  /^(hot nhat|dang hot|trending|thinh hanh nhat|thinh hanh|noi nhat|noi tieng nhat|hay nhat|dinh nhat|top|hit|hits) (cua|of|by) /;
const ME = /^(toi|minh|em|tui|tao|me)$/;
const ALL =
  /^(het|tat ca|toan bo|ca hang cho|het hang cho|hang cho|moi bai|tat ca cac bai|het cac bai|het tat ca)( |$)/;
const OWNER =
  /^((het|tat ca|cac|nhung|may|moi) )?(cac |nhung )?(bai )?(hat )?(cua) /;
/** "bài Lan chọn", "những bài do Lan thêm". */
const PICKED_BY =
  /^((het|tat ca|cac|nhung) )?(bai )?(ma |do )?(.+?) (da )?(chon|them|bat|xep|order)$/;
const OTHERS =
  /^((het|tat ca|cac|nhung) )?(bai )?(cua )?(nguoi khac|moi nguoi khac|nguoi ta|nguoi con lai|ke khac)$/;
const EXCEPT = / (tru|ngoai tru|tru ra|tru bai|except|but not) /;
const INTO = / (thanh|bang|sang|qua) /;
/** "đến / tới / sang bài …" after skip. */
const TO = /^(den|toi|sang|qua|len|ve|to)( |$)/;
const THIS = /^((bai )?(nay|dang phat|hien tai|do)|no|di|luon|ngay)$/;

/** "kèm lời chúc …", "với lời nhắn: …"; "tặng Lan" becomes the wish "Tặng Lan". */
const WISH =
  /[\s,]*(?:kèm|với|cùng|có)?\s*(?:theo\s+)?(?:lời chúc|lời nhắn|lời tặng|câu chúc)\s*(?:là|rằng)?\s*[:\-–]?\s*(.+)$/iu;
const GIFT = /[\s,]*(?:để\s+)?(?:dành tặng|gửi tặng|tặng)\s+(?:cho\s+)?(.+)$/iu;

function unquote(s: string): string {
  return s
    .trim()
    .replace(/^["“”'‘’«]+|["“”'‘’»]+$/g, '')
    .trim();
}

export function extractWish(text: string): { rest: string; wish?: string } {
  for (const [re, make] of [
    [WISH, (w: string) => w],
    [GIFT, (w: string) => `Tặng ${w}`],
  ] as const) {
    const m = re.exec(text);
    const w = m ? unquote(m[1]) : '';
    if (m && w)
      return {
        rest: text.slice(0, m.index).trim(),
        wish: make(w).slice(0, LIMITS.wish),
      };
  }
  return { rest: text };
}

function numberOf(w: string | undefined): number | null {
  if (!w) return null;
  if (/^\d+$/.test(w)) return Number(w);
  return NUMBERS[w] ?? null;
}

/** Words of `p` (plain) matched at the start by `re`, or 0. */
function lead(p: string, re: RegExp): number {
  const m = re.exec(p);
  return m ? m[0].trim().split(' ').filter(Boolean).length : 0;
}

/** `p` and the original text without their first `n` words. */
function drop(
  p: string,
  original: string,
  n: number,
): { p: string; original: string } {
  if (!n) return { p, original };
  return {
    p: p.split(' ').slice(n).join(' '),
    original: words(original).slice(n).join(' '),
  };
}

function verbOf(seg: string): { verb: Verb; rest: string } | null {
  let p = plain(seg);
  let o = seg;
  ({ p, original: o } = drop(p, o, lead(p, FILLER_START)));
  for (const [verb, re] of VERBS) {
    const n = lead(p, re);
    if (!n) continue;
    let v = verb;
    // "tim" without accents: "tìm" (look for) or "tim" (heart). Followed by a number of
    // songs or an artist, it is a search.
    const first = words(o)[0];
    if (v === 'add' && p.startsWith('tim ') && first === 'tim') {
      const after = p.slice(4);
      if (!COUNT.test(after) && !BY.test(after)) v = 'heart';
    }
    ({ p, original: o } = drop(p, o, n));
    ({ p, original: o } = drop(p, o, lead(p, AFTER_VERB)));
    // "đưa Lạc Trôi vào hàng chờ": an add, not a pin.
    const into = / vao (hang cho|danh sach( phat)?|list|queue|playlist)$/.exec(
      ` ${p}`,
    );
    if (v === 'pin' && into) {
      const ws = words(o);
      return {
        verb: 'add',
        rest: ws
          .slice(0, ws.length - into[0].trim().split(' ').length)
          .join(' '),
      };
    }
    return { verb: v, rest: o };
  }
  // "cho tôi 3 bài của Mỹ Tâm" (the polite words are the verb), "@DJ 2 bài chill", "top 3 Đen".
  if (COUNT.test(p) || TOP_ONLY.test(p)) return { verb: 'add', rest: o };
  return null;
}

/** "3 bài", "vài bài", "top 5", "nhiều bài" → how many, and the words after it. */
function countOf(o: string): {
  count: number;
  asked?: number;
  rest: string;
  said: boolean;
  top: boolean;
} {
  const p = plain(o);
  const m = COUNT.exec(p) ?? TOP_ONLY.exec(p);
  if (m) {
    const head = m[0].trim().split(' ');
    const top = head[0] === 'top';
    const w = top ? head[1] : head[0];
    // "một loạt", "một vài" before "một" (1).
    const two = head.slice(0, 2).join(' ');
    const n = MANY_WORD.test(two)
      ? MAX_SONGS
      : FEW_WORDS.test(two)
        ? SOME
        : (numberOf(w) ?? (MANY_WORD.test(w) ? MAX_SONGS : SOME));
    return {
      count: Math.max(1, Math.min(MAX_SONGS, n)),
      ...(n > MAX_SONGS ? { asked: n } : {}),
      rest: drop(p, o, head.length).original,
      said: true,
      top,
    };
  }
  return {
    count: 1,
    rest: drop(p, o, lead(p, ONE)).original,
    said: false,
    top: false,
  };
}

/** "… ngay sau bài này" / "… luôn": pin the song next, or play it now. */
function pinOf(o: string): { pin?: Pin; rest: string } {
  const p = plain(o);
  for (const [re, pin] of [
    [PIN_NEXT, 'next'],
    [PIN_NOW, 'now'],
  ] as const) {
    const m = re.exec(p);
    if (!m) continue;
    const n = m[0].trim().split(' ').length;
    const ws = words(o);
    // "Chạy Ngay Đi" ends in "Đi"; "… Ngay" capitalised after a capitalised word is a title's.
    if (
      m[2] === 'ngay' &&
      ws.length > 1 &&
      /^\p{Lu}/u.test(ws[ws.length - 1]) &&
      /^\p{Lu}/u.test(ws[ws.length - 2])
    )
      continue;
    return { pin, rest: ws.slice(0, ws.length - n).join(' ') };
  }
  return { rest: o };
}

function addObject(obj: string, again: boolean): PlanStep | null {
  const { pin, rest: noPin } = pinOf(obj);
  const { count, asked, rest, said, top } = countOf(noPin);
  const p = plain(rest);
  const many = said ? count : again ? SOME : 1;
  const more = asked ? { asked } : {};
  if (again || PLAYED.test(p))
    return { do: 'addFrom', source: 'played', count: many, pin, ...more };
  if (SAVED.test(p))
    return { do: 'addFrom', source: 'saved', count: many, pin, ...more };
  const best = lead(p, BEST);
  if (best) {
    const artist = tail(rest, best);
    if (artist && !vagueIn(artist))
      return {
        do: 'addArtist',
        artist,
        count,
        mode: /^(hot|dang hot|trending|thinh hanh)( |$)/.test(p)
          ? 'popular'
          : 'top',
        pin,
        ...more,
      };
  }
  const fresh = freshMatch(rest, p, 0);
  if (fresh)
    return {
      do: 'addArtist',
      artist: fresh.artist,
      count,
      mode: fresh.mode,
      pin,
      ...more,
    };
  const by = lead(p, BY);
  if (by) {
    const artist = tail(rest, by);
    if (!artist || vagueIn(artist)) return null;
    return { do: 'addArtist', artist, count, mode: 'top', pin, ...more };
  }
  // "thêm 3 bài", "thêm vài bài nữa": the DJ picks for the room.
  if (!p)
    return said
      ? {
          do: 'addVague',
          text: 'nhạc hợp không khí phòng',
          count,
          pin,
          ...more,
        }
      : null;
  // "top 5 Sơn Tùng": an artist's best songs.
  if (top) {
    const artist = tail(rest, 0);
    if (artist && !vagueIn(artist))
      return { do: 'addArtist', artist, count, mode: 'top', pin, ...more };
  }
  if (vagueIn(rest) || said)
    return { do: 'addVague', text: rest, count, pin, ...more };
  const title = tail(rest, 0);
  return title ? { do: 'add', titles: [title], pin } : null;
}

/** A place in the queue: "bài số 2", "bài thứ hai", "bài cuối", "3 bài đầu", "2 bài cuối". */
function placeOf(p: string, t: Target, positional: boolean): boolean {
  let m = new RegExp(`^(bai )?(so|thu) ${NUM}$`).exec(p);
  m ??= new RegExp(`^bai ${NUM}$`).exec(p);
  // "bài số 2 và 4": a number alone after a place is another place.
  m ??= positional ? new RegExp(`^(so )?${NUM}$`).exec(p) : null;
  if (m) {
    const n = numberOf(m[m.length - 1]);
    if (n) (t.positions ??= []).push(n);
    return Boolean(n);
  }
  if (/^(bai )?(dau tien|dau|tiep theo|ke tiep|sap toi|sap phat)$/.test(p)) {
    (t.positions ??= []).push(1);
    return true;
  }
  if (
    /^(bai )?(cuoi|cuoi cung|chot|sau cung)( (trong|cua) hang cho)?$/.test(p)
  ) {
    (t.positions ??= []).push(-1);
    return true;
  }
  if (/^(bai )?(ke cuoi|gan cuoi)$/.test(p)) {
    (t.positions ??= []).push(-2);
    return true;
  }
  m = new RegExp(`^${NUM} bai (dau|dau tien)$`).exec(p);
  if (m) {
    t.first = numberOf(m[1]) ?? 1;
    return true;
  }
  m = new RegExp(
    `^(${NUM} )?bai (cuoi|sau cung|cuoi cung|moi them|vua them|moi chon|vua chon)( cua (toi|minh|em|tui))?$`,
  ).exec(p);
  m ??= new RegExp(
    `^(${NUM} )?bai (toi|minh|em|tui) (vua|moi) (them|chon)$`,
  ).exec(p);
  if (m) {
    t.last = numberOf(m[2]) ?? 1;
    // "2 bài cuối" are the queue's; "2 bài cuối của tôi", "bài tôi vừa thêm" the asker's.
    if (/ (cua (toi|minh|em|tui)|(vua|moi) (them|chon))$/.test(p))
      t.mine = true;
    return true;
  }
  return false;
}

/** English places and owners, said the Vietnamese way (names keep their words). */
const ENGLISH: [RegExp, string][] = [
  [/^(the )?(last|final)( song| one)?$/i, 'bài cuối'],
  [/^(the )?(next|first)( song| one)?$/i, 'bài đầu'],
  [/^(the )?second( song| one)?$/i, 'bài số 2'],
  [/^(the )?third( song| one)?$/i, 'bài số 3'],
  [/^(song|track) (number |no\.? |#)?(\d+)$/i, 'bài số $3'],
  [/^(the )?(\d+)(st|nd|rd|th) (song|one)$/i, 'bài số $2'],
  [/^(the )?first (\d+)( songs)?$/i, '$2 bài đầu'],
  [/^(the )?last (\d+)( songs)?$/i, '$2 bài cuối'],
  [/^(all )?(of )?(my songs?|mine)$/i, 'bài của tôi'],
  [
    /^(all )?(of )?(the )?songs? (added |picked |queued )?by (.+)$/i,
    'bài của $5',
  ],
  [
    /^(all )?(other people'?s|others'?|everyone else'?s)( songs)?$/i,
    'bài của người khác',
  ],
  [
    /^(all|everything|all songs|all the songs|the whole queue|the queue|whole queue)$/i,
    'tất cả',
  ],
  [/^(.+)'s songs$/i, 'bài của $1'],
];
function english(o: string): string {
  for (const [re, to] of ENGLISH) if (re.test(o)) return o.replace(re, to);
  return o;
}

/** "bài Lạc Trôi" → "Lạc Trôi". */
function stripOne(o: string): string {
  const p = plain(o);
  return tail(drop(p, o, lead(p, ONE)).original, 0);
}

/** Queue songs named in a heart / remove / pin: whose, which titles, which places, except… */
function targetOf(objs: string[]): Target | null {
  const t: Target = {};
  let excepting = false;
  let positional = false;
  const said: string[] = [];
  for (const raw of objs) {
    let shown = tail(raw, 0);
    let obj = english(shown);
    if (excepting) {
      const kept = stripOne(obj);
      if (kept) (t.except ??= []).push(kept);
      continue;
    }
    // "hết bài của tôi trừ Lạc Trôi": what follows "trừ" (and the next parts) is kept.
    const ex = EXCEPT.exec(` ${plain(obj)} `);
    if (ex) {
      const at = ` ${plain(obj)} `
        .slice(0, ex.index)
        .trim()
        .split(' ')
        .filter(Boolean).length;
      const ws = words(obj);
      const kept = stripOne(
        ws.slice(at + ex[0].trim().split(' ').length).join(' '),
      );
      shown = ws.slice(0, at).join(' ');
      obj = english(shown);
      excepting = true;
      // "xoá hết trừ bài của tôi": everyone else's.
      if (/^(bai )?(cua )?(toi|minh|em|tui)$/.test(plain(kept)))
        t.others = true;
      else if (kept) (t.except ??= []).push(kept);
      if (!obj) continue;
    }
    const p = plain(obj);
    if (!p || /^(bai nay|no)$/.test(p)) continue;
    said.push(shown);
    if (placeOf(p, t, positional)) {
      positional = true;
      continue;
    }
    if (OTHERS.test(p)) {
      t.others = true;
      continue;
    }
    // "hết bài của Lan": someone's songs, checked before "hết" (all).
    const owner = lead(p, OWNER);
    if (owner) {
      const name = tail(obj, owner);
      if (ME.test(plain(name))) t.mine = true;
      else if (name) t.by = name;
      continue;
    }
    if (ALL.test(p)) {
      const after = drop(p, obj, lead(p, ALL)).p;
      if (/^(bai )?(cua )?(toi|minh|em|tui)$/.test(after)) t.mine = true;
      else if (/^(bai )?(cua )?(nguoi khac|nguoi ta)$/.test(after))
        t.others = true;
      else t.all = true;
      continue;
    }
    const picked = PICKED_BY.exec(p);
    if (picked) {
      const n = picked[5].split(' ').length;
      const at = p.split(' ').length - n - (picked[6] ? 2 : 1);
      const name = words(obj)
        .slice(at, at + n)
        .join(' ');
      if (ME.test(picked[5])) t.mine = true;
      else if (name) t.by = name;
      continue;
    }
    let title = stripOne(obj);
    // "Nàng Thơ của tôi": the title without the owner.
    if (/ cua (toi|minh|em|tui)$/.test(plain(title))) {
      const ws = words(title);
      title = ws.slice(0, ws.length - 2).join(' ');
      t.mine = true;
    }
    if (title) (t.titles ??= []).push(title);
  }
  const found = Object.keys(t).length > 0;
  if (said.length) t.said = said.join(', ');
  return found ? t : null;
}

function multiTarget(t: Target): boolean {
  return Boolean(
    t.all ||
    t.mine ||
    t.others ||
    t.by ||
    t.last ||
    t.first ||
    t.except ||
    t.positions?.length ||
    (t.titles?.length ?? 0) > 1,
  );
}

/** "skip", "bỏ qua 2 bài", "skip đến bài cuối", "chuyển sang Lạc Trôi". */
function skipOf(objs: string[]): PlanStep {
  const first = objs[0] ? tail(objs[0], 0) : '';
  const p = plain(first);
  if (!p || THIS.test(p)) return { do: 'skip' };
  const to = lead(p, TO);
  if (!to) {
    const m = new RegExp(`^${NUM} (bai|songs?)( nua| lien| more)?$`).exec(p);
    const n = numberOf(m?.[1]);
    if (n) return { do: 'skip', count: Math.min(MAX_SKIPS, n) };
  }
  const target = targetOf([drop(p, first, to).original, ...objs.slice(1)]);
  return target ? { do: 'pin', target, now: true } : { do: 'skip' };
}

/** More than one press of one button (the asker could do that alone): the DJ does it. */
function isCombo(steps: PlanStep[], wish?: string): boolean {
  const adds = steps.some((s) => s.do.startsWith('add') || s.do === 'replace');
  return (
    steps.length > 1 ||
    (Boolean(wish) && adds) ||
    steps.some(
      (s) =>
        (s.do === 'add' && (s.titles.length > 1 || s.pin)) ||
        (s.do === 'addArtist' &&
          (s.count > 1 || s.mode === 'top' || s.pin || s.asked)) ||
        (s.do === 'addVague' && (s.count > 1 || s.pin || s.asked)) ||
        s.do === 'addFrom' ||
        s.do === 'addPicks' ||
        ((s.do === 'heart' || s.do === 'remove') && multiTarget(s.target)) ||
        s.do === 'pin' ||
        (s.do === 'skip' && (s.count ?? 1) > 1) ||
        s.do === 'replace',
    )
  );
}

/** The songs of one "add" verb: titles, an artist's, vague, from the history… */
function addClause(objs: string[], again: boolean): PlanStep[] {
  // "thêm 3 bài: A, B, C", "thêm 2 bài là A và B", "thêm 3 bài A, B, C": a list of titles.
  if (objs.length > 1) {
    const c = countOf(objs[0]);
    const head = plain(c.rest);
    if (
      c.said &&
      objs.slice(1).every((o) => !countOf(o).said) &&
      !BY.test(head) &&
      !BEST.test(head) &&
      !SAVED.test(head) &&
      !PLAYED.test(head) &&
      (!c.rest || !vagueIn(c.rest))
    ) {
      const list = [
        c.rest.replace(/^(là|gồm|la|gom|như|nhu)\s+/iu, ''),
        ...objs.slice(1),
      ].filter((o) => o.trim());
      const { pin, rest: lastTitle } = pinOf(list[list.length - 1]);
      list[list.length - 1] = lastTitle;
      const titles = list.map((o) => tail(o, 0)).filter(Boolean);
      if (titles.length)
        return [{ do: 'add', titles, ...(pin ? { pin } : {}) }];
    }
  }
  const adds: PlanStep[] = [];
  for (const obj of objs.length ? objs : [''])
    if (obj || again) {
      const s = addObject(obj, again);
      if (s) adds.push(s);
    }
  // "thêm Lạc Trôi và Nàng Thơ": one add of several titles.
  const titles = adds.filter((s) => s.do === 'add');
  if (titles.length > 1) {
    const first = adds.indexOf(titles[0]);
    adds.splice(first, 1, {
      do: 'add',
      titles: titles.flatMap((s) => s.titles),
      pin: titles.find((s) => s.pin)?.pin,
    });
    for (const s of titles.slice(1)) adds.splice(adds.indexOf(s), 1);
  }
  return adds;
}

/** A request the DJ carries out itself, or null (a single task: the rules answer it). */
export function planCombo(request: string): Plan | null {
  const { rest, wish } = extractWish(request.trim());
  const segs = rest
    .replace(LIST_NUMBER, '$1, ')
    .split(SEP)
    .map((s) => s.replace(/^[\s:–-]+|[\s:–-]+$/g, ''))
    .filter(Boolean);
  if (!segs.length) return null;

  // Each verb starts a task; the segments after it without a verb are more of its objects.
  // Words before the first verb ("mình buồn quá, …") are talk, not a task.
  const clauses: { verb: Verb; objs: string[] }[] = [];
  for (const seg of segs) {
    const v = verbOf(seg);
    if (v) clauses.push({ verb: v.verb, objs: v.rest ? [v.rest] : [] });
    else if (clauses.length) clauses[clauses.length - 1].objs.push(seg);
  }
  if (!clauses.length) return null;

  const steps: PlanStep[] = [];
  for (const { verb, objs } of clauses) {
    switch (verb) {
      case 'add':
      case 'addAgain':
        steps.push(...addClause(objs, verb === 'addAgain'));
        break;
      case 'heart':
      case 'remove': {
        const target = targetOf(objs);
        if (target) steps.push({ do: verb, target });
        break;
      }
      case 'pin': {
        const { pin, rest: first } = pinOf(objs[0] ?? '');
        const target = targetOf([first, ...objs.slice(1)].filter(Boolean));
        if (target) steps.push({ do: 'pin', target, now: pin === 'now' });
        break;
      }
      case 'skip':
        steps.push(skipOf(objs));
        break;
      case 'replace': {
        const obj = objs.join(' ');
        const p = plain(obj);
        const m = INTO.exec(p);
        if (!m) break;
        const at = p.slice(0, m.index).split(' ').length;
        const ws = words(obj);
        const from = targetOf([ws.slice(0, at).join(' ')]);
        const to = ws.slice(at + 1).join(' ');
        const title = from?.titles?.[0];
        if (title && to)
          steps.push({ do: 'replace', from: title, to: tail(to, 0) });
        break;
      }
      default:
        steps.push({ do: verb });
    }
  }
  if (!steps.length || !isCombo(steps, wish)) return null;
  const adds = steps.some((s) => s.do.startsWith('add') || s.do === 'replace');
  return { steps, ...(wish && adds ? { wish } : {}) };
}

// ------------------------------------------------------------------ the AI's plan

export const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
export const int = (v: unknown, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.max(1, Math.min(max, Math.round(v)))
    : undefined;
export const strs = (v: unknown, max: number): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => str(x, 150)).filter((x): x is string => Boolean(x));
  return out.length ? out.slice(0, max) : undefined;
};

function targetIn(v: unknown): Target | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const positions = Array.isArray(o.positions)
    ? o.positions
        .filter(
          (n): n is number =>
            typeof n === 'number' && Number.isInteger(n) && n !== 0,
        )
        .slice(0, 20)
    : [];
  const by = str(o.by, 100);
  const titles = strs(o.titles, 10);
  const except = strs(o.except, 10);
  const first = int(o.first, 50);
  const last = int(o.last, 50);
  const t: Target = {
    ...(o.all === true ? { all: true } : {}),
    ...(o.mine === true ? { mine: true } : {}),
    ...(o.others === true ? { others: true } : {}),
    ...(by ? { by } : {}),
    ...(titles ? { titles } : {}),
    ...(except ? { except } : {}),
    ...(positions.length ? { positions } : {}),
    ...(first ? { first } : {}),
    ...(last ? { last } : {}),
  };
  return Object.keys(t).length ? t : null;
}

/**
 * The AI planner's steps (dj-brain SYSTEM, intent "do"), checked one by one: anything malformed
 * is dropped, counts are clamped. null when nothing usable is left.
 */
export function planFromAi(steps: unknown, wish: unknown): Plan | null {
  if (!Array.isArray(steps)) return null;
  const out: PlanStep[] = [];
  for (const raw of steps.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const pin = s.pin === 'next' || s.pin === 'now' ? s.pin : undefined;
    const asked =
      typeof s.count === 'number' && s.count > MAX_SONGS
        ? { asked: Math.round(s.count) }
        : {};
    const count = int(s.count, MAX_SONGS) ?? 1;
    switch (s.do) {
      case 'add': {
        const titles = strs(s.titles, MAX_SONGS);
        if (titles) out.push({ do: 'add', titles, ...(pin ? { pin } : {}) });
        break;
      }
      case 'addArtist': {
        const artist = str(s.artist, 100);
        const mode =
          s.mode === 'latest' || s.mode === 'popular' ? s.mode : 'top';
        if (artist)
          out.push({ do: 'addArtist', artist, count, mode, pin, ...asked });
        break;
      }
      case 'addPicks': {
        const picks = (Array.isArray(s.items) ? (s.items as unknown[]) : [])
          .map((p) => {
            const o = (p ?? {}) as Record<string, unknown>;
            const artist = str(o.artist, 100);
            const song = str(o.song, 150);
            return artist && song ? { artist, song } : null;
          })
          .filter((p): p is { artist: string; song: string } => p !== null)
          .slice(0, MAX_SONGS);
        if (picks.length) out.push({ do: 'addPicks', picks, pin });
        break;
      }
      case 'addFrom':
        if (s.source === 'played' || s.source === 'saved')
          out.push({ do: 'addFrom', source: s.source, count, pin, ...asked });
        break;
      case 'heart':
      case 'remove':
      case 'pin':
      case 'skipTo': {
        const target = targetIn(s.target);
        if (!target) break;
        if (s.do === 'heart' || s.do === 'remove')
          out.push({ do: s.do, target });
        else
          out.push({
            do: 'pin',
            target,
            now: s.do === 'skipTo' || pin === 'now',
          });
        break;
      }
      case 'skip':
        out.push({ do: 'skip', count: int(s.count, MAX_SKIPS) ?? 1 });
        break;
      case 'pause':
      case 'resume':
        out.push({ do: s.do });
        break;
    }
  }
  if (!out.length) return null;
  const w = str(wish, LIMITS.wish);
  const adds = out.some((s) => s.do.startsWith('add'));
  return { steps: out, ...(w && adds ? { wish: w } : {}) };
}

/** The AI's plan is one simple task: the guide that shows its button, if there is one. */
export function guideOfAiPlan(
  plan: Plan,
): 'heart' | 'skip' | 'pause' | 'myItem' | null {
  if (isCombo(plan.steps, plan.wish)) return null;
  const s = plan.steps[0];
  if (s.do === 'heart') return 'heart';
  if (s.do === 'skip') return 'skip';
  if (s.do === 'pause' || s.do === 'resume') return 'pause';
  if (s.do === 'remove') return 'myItem';
  return null;
}
