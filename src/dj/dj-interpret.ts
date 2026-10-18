import type { DjClarify, GuideTarget, InfoKind } from '../contracts';
import { type Plan, planCombo, type Target } from './dj-plan';
import { howTopic, isHowQuestion, matchQuick, matchRules } from './dj-rules';
import {
  parseTranslation,
  TRANSLATE_SYSTEM,
  translateInput,
} from './dj-translate';

/**
 * What "@DJ <request>" means, decided in one place (no side effects): quick rules for short,
 * certain commands, otherwise one AI call that sees the room, then the product rules (how-to
 * questions and one-button tasks are shown, not done; removing is never guessed). The DJ
 * brain carries the decision out; scripts/dj-eval scores it on a fixed set of sentences.
 */

/** The room as the AI sees it: enough to resolve "bài này", "bài của Lan", "bài số 3". */
export interface RoomContext {
  asker: string;
  /** People in the room (not speakers), the asker included. */
  members: string[];
  nowPlaying: {
    title: string;
    artist: string | null;
    by: string | null;
  } | null;
  /** Play order, the next song first (at most QUEUE_FOR_AI). */
  queue: { title: string; artist: string | null; by: string | null }[];
}

/** Queue songs shown to the AI: enough for "bài số 10", short enough for the free quota. */
export const QUEUE_FOR_AI = 15;

export type Decision =
  | { kind: 'hello' }
  | { kind: 'other' }
  | { kind: 'busy'; retryAfterSec?: number }
  | { kind: 'info'; info: InfoKind }
  | { kind: 'guide'; guide: GuideTarget }
  | { kind: 'clarify'; about: DjClarify }
  | { kind: 'chat'; reply: string | null }
  | { kind: 'plan'; plan: Plan };

/** Where "@DJ" was asked: the room page (spotlight) or Slack (no spotlight). */
export type Platform = 'room' | 'slack';

/**
 * The one AI call of a request. `ok: false`: no answer (AI off, every provider resting, or the
 * asker's quota spent: `retryAfterSec` > 0).
 */
export type AiCall = (
  system: string,
  user: string,
) => Promise<{ ok: true; raw: unknown } | { ok: false; retryAfterSec: number }>;

export interface InterpretInput {
  request: string;
  room: RoomContext;
  platform: Platform;
  /** null: no AI configured. */
  ai: AiCall | null;
}

/** One queue song named by title or place, nothing wider ("bài Lạc Trôi", "bài số 2"). */
function oneSong(t: Target): boolean {
  if (t.all || t.others || t.by || t.artist || t.keep || t.except?.length)
    return false;
  return (
    t.titles?.length === 1 ||
    t.positions?.length === 1 ||
    t.first === 1 ||
    t.last === 1
  );
}

/**
 * A single task that is one button of the "Hướng dẫn" sheet (skip one song, pause, save the song
 * on air, heart / remove / pin one song): the room page shows the button instead of pressing it
 * (user's choice, 2026-10-18). Several tasks, songs to find, or many songs are still done.
 */
export function guideOfSingle(plan: Plan): GuideTarget | null {
  if (plan.wish || plan.steps.length !== 1) return null;
  const s = plan.steps[0];
  switch (s.do) {
    case 'skip':
      return (s.count ?? 1) === 1 ? 'skip' : null;
    case 'pause':
    case 'resume':
      return 'pause';
    case 'save':
      return s.target ? null : 'save';
    case 'heart':
      return oneSong(s.target) ? 'heart' : null;
    case 'remove':
      return oneSong(s.target) ? 'itemMenu' : null;
    case 'pin':
      // "Phát ngay bài X" is two buttons (pin, then skip): the DJ does it.
      return !s.now && oneSong(s.target) ? 'itemMenu' : null;
    default:
      return null;
  }
}

/** The help topic a task belongs to, for "làm sao để <task>" read by the AI as the task. */
export function guideOfPlan(plan: Plan): GuideTarget | null {
  const s = plan.steps[0];
  if (!s) return null;
  switch (s.do) {
    case 'skip':
      return 'skip';
    case 'pause':
    case 'resume':
      return 'pause';
    case 'heart':
      return 'heart';
    case 'remove':
    case 'pin':
    case 'replace':
    case 'replaceWith':
      return 'itemMenu';
    case 'save':
      return s.target ? 'playlist' : 'save';
    case 'playlistSave':
    case 'playlistCreate':
    case 'playlistPlay':
      return 'playlist';
    case 'find':
      return s.suggest ? 'suggestions' : 'add';
    default:
      return 'add';
  }
}

/** A plan as the platform takes it: one-button tasks become their button on the room page. */
function planFor(plan: Plan, platform: Platform): Decision {
  const single = platform === 'room' ? guideOfSingle(plan) : null;
  return single ? { kind: 'guide', guide: single } : { kind: 'plan', plan };
}

export async function interpret({
  request,
  room,
  platform,
  ai,
}: InterpretInput): Promise<Decision> {
  const quick = matchQuick(request);
  if (quick)
    return quick.kind === 'plan' ? planFor(quick.plan, platform) : quick;
  if (!ai) return withoutAi(request, platform);
  const r = await ai(TRANSLATE_SYSTEM, translateInput(room, request));
  if (!r.ok) return withoutAi(request, platform, r.retryAfterSec);
  const t = parseTranslation(r.raw);
  // "Làm sao để …": show where it is, never do it (even when the AI read it as the task).
  if (isHowQuestion(request)) {
    const guide =
      t.kind === 'guide'
        ? t.guide
        : t.kind === 'plan'
          ? guideOfPlan(t.plan)
          : null;
    if (guide) return { kind: 'guide', guide };
    if (t.kind === 'info') return t;
    return howTopic(request)
      ? { kind: 'guide', guide: howTopic(request)! }
      : { kind: 'other' };
  }
  return t.kind === 'plan' ? planFor(t.plan, platform) : t;
}

/**
 * No AI (off, quota spent or every provider resting): the old combo rules may add, suggest or
 * answer, but never remove (removing is never a guess). `retryAfterSec`: the asker's quota is
 * spent (> 0) or the providers rest (0); undefined = no AI at all.
 */
function withoutAi(
  request: string,
  platform: Platform,
  retryAfterSec?: number,
): Decision {
  const busy: Decision =
    retryAfterSec !== undefined
      ? { kind: 'busy', ...(retryAfterSec > 0 ? { retryAfterSec } : {}) }
      : { kind: 'other' };
  if (isHowQuestion(request)) {
    const topic = howTopic(request);
    return topic ? { kind: 'guide', guide: topic } : busy;
  }
  const plan = planCombo(request);
  const safe = plan?.steps.filter(
    (s) => s.do !== 'remove' && s.do !== 'replace',
  );
  if (plan && safe?.length && safe.length === plan.steps.length)
    return planFor({ ...plan, steps: safe }, platform);
  const rule = matchRules(request);
  if (rule?.kind === 'info') return { kind: 'info', info: rule.info };
  // "bài mới của Đen": a real YouTube lookup, no AI needed.
  if (rule?.kind === 'fresh')
    return {
      kind: 'plan',
      plan: {
        steps: [
          {
            do: 'find',
            find: { artist: rule.artist, mode: rule.mode },
            count: 1,
          },
        ],
      },
    };
  if (rule?.kind === 'guide' && rule.guide !== 'add')
    return { kind: 'guide', guide: rule.guide };
  return busy;
}
