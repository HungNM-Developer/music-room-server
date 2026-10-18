/**
 * Scores the "@DJ" brain on a fixed set of sentences (cases.json): what each one is understood
 * as (src/dj/dj-interpret.ts), against what it should be. Run by hand before changing the DJ:
 *
 *   npm run dj:eval                  every case
 *   npm run dj:eval -- --only xoá    cases whose text holds "xoá"
 *   npm run dj:eval -- --fresh       ignore the AI answer cache
 *   npm run dj:eval -- --cached      only cases whose AI answer is cached (no AI call at all)
 *
 * Uses the free AI keys of .env (Gemini, then Groq). AI answers are cached per prompt and
 * sentence in node_modules/.cache, so a re-run only asks for what changed. Nothing is done in
 * any room: no songs are looked up, added or removed.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { AiService } from '../../src/ai/ai.service';
import { parseEnv } from '../../src/config/env';
import { normalizeQuery } from '../../src/contracts';
import type { PlanStep } from '../../src/dj/dj-plan';
import {
  type AiCall,
  type Decision,
  interpret,
  type Platform,
  type RoomContext,
} from '../../src/dj/dj-interpret';

config({ path: join(__dirname, '../../.env'), quiet: true });

interface Case {
  text: string;
  /** Parts of the decision that must be there (see `matches`). */
  expect: unknown;
  /** Step kinds ("do") that must not appear, e.g. ["remove"]. */
  forbid?: string[];
  platform?: Platform;
  /** Replaces the room's members (e.g. someone called "Đen"). */
  members?: string[];
  note?: string;
}

interface Suite {
  room: RoomContext;
  cases: Case[];
}

const CACHE_DIR = join(__dirname, '../../node_modules/.cache');
const CACHE_FILE = join(CACHE_DIR, 'dj-eval-ai.json');
const REPORT_FILE = join(CACHE_DIR, 'dj-eval-report.json');
/** Between AI calls: the free tiers count requests and tokens per minute. */
const DELAY_MS = Number(process.env.DJ_EVAL_DELAY_MS ?? 13_000);

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const fresh = args.includes('--fresh');
const cachedOnly = args.includes('--cached');

/** A case the AI was not asked about (`--cached`, no cached answer): left out of the score. */
class Skipped extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (v: unknown) => normalizeQuery(String(v));

/**
 * `expected` inside `actual`: strings are contained (accents and case aside), numbers and
 * booleans equal, arrays element by element (same length unless the last expected item is
 * "..."), objects key by key; `null` means "absent".
 */
function matches(actual: unknown, expected: unknown, path = ''): string | null {
  if (expected === null)
    return actual === undefined || actual === null
      ? null
      : `${path}: should be absent, is ${JSON.stringify(actual)}`;
  if (typeof expected === 'string')
    return typeof actual === 'string' && norm(actual).includes(norm(expected))
      ? null
      : `${path}: "${String(actual)}" does not hold "${expected}"`;
  if (typeof expected === 'number' || typeof expected === 'boolean')
    return actual === expected
      ? null
      : `${path}: ${JSON.stringify(actual)} ≠ ${String(expected)}`;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: not a list`;
    const open = expected[expected.length - 1] === '...';
    const items = open ? expected.slice(0, -1) : expected;
    if (open ? actual.length < items.length : actual.length !== items.length)
      return `${path}: ${actual.length} items, expected ${open ? 'at least ' : ''}${items.length}`;
    for (let i = 0; i < items.length; i++) {
      const m = matches(actual[i], items[i], `${path}[${i}]`);
      if (m) return m;
    }
    return null;
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return `${path}: missing`;
    for (const [k, v] of Object.entries(expected)) {
      const m = matches(
        (actual as Record<string, unknown>)[k],
        v,
        path ? `${path}.${k}` : k,
      );
      if (m) return m;
    }
    return null;
  }
  return null;
}

function forbidden(d: Decision, kinds: string[] = []): string | null {
  if (d.kind !== 'plan') return null;
  const bad = d.plan.steps.find((s) => kinds.includes(s.do));
  return bad ? `forbidden step "${bad.do}"` : null;
}

/**
 * The decision as the expectations are written: plans flattened to their steps, and songs named
 * one by one ("thêm A và B" read as two adds) joined into one add, the way the executor treats
 * them: either form is the same request.
 */
function shape(d: Decision): unknown {
  if (d.kind !== 'plan') return d;
  const steps: PlanStep[] = [];
  for (const s of d.plan.steps) {
    const prev = steps[steps.length - 1];
    const titlesOnly = (x: PlanStep) =>
      x.do === 'find' &&
      !x.suggest &&
      Boolean(x.find.titles?.length) &&
      !x.find.artist &&
      !x.find.mode &&
      !x.find.exclude;
    if (
      prev?.do === 'find' &&
      s.do === 'find' &&
      titlesOnly(prev) &&
      titlesOnly(s) &&
      prev.pin === s.pin
    ) {
      steps[steps.length - 1] = {
        ...prev,
        find: {
          ...prev.find,
          titles: [...prev.find.titles!, ...s.find.titles!],
        },
        count: prev.count + s.count,
      };
      continue;
    }
    steps.push(s);
  }
  return { kind: 'plan', steps, wish: d.plan.wish };
}

async function main(): Promise<void> {
  const suite = JSON.parse(
    readFileSync(join(__dirname, 'cases.json'), 'utf8'),
  ) as Suite;
  const env = parseEnv(process.env);
  let ai = new AiService(env);
  if (!ai.enabled)
    throw new Error('No AI key in .env (GEMINI_API_KEY / GROQ_API_KEY)');
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const cache: Record<string, unknown> =
    !fresh && existsSync(CACHE_FILE)
      ? (JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<
          string,
          unknown
        >)
      : {};

  let lastCall = 0;
  const aiCall: AiCall = async (system, user) => {
    const key = createHash('sha1')
      .update(system)
      .update('\0')
      .update(user)
      .digest('hex');
    if (key in cache) return { ok: true, raw: cache[key] };
    if (cachedOnly) throw new Skipped();
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = lastCall + DELAY_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      const raw = await ai.json<unknown>('dj-eval', system, user, {
        temperature: 0.2,
        timeoutMs: 20_000,
      });
      if (raw !== null) {
        cache[key] = raw;
        writeFileSync(CACHE_FILE, JSON.stringify(cache));
        return { ok: true, raw };
      }
      // Every provider hit its per-minute limit and was set to rest: wait, then start afresh.
      await sleep(60_000);
      ai = new AiService(env);
    }
    return { ok: false, retryAfterSec: 0 };
  };

  const cases = suite.cases.filter(
    (c) => !only || norm(c.text).includes(norm(only)),
  );
  const failed: { text: string; why: string; got: unknown; note?: string }[] =
    [];
  let skipped = 0;
  for (const [i, c] of cases.entries()) {
    const room = c.members ? { ...suite.room, members: c.members } : suite.room;
    let d: Decision;
    try {
      d = await interpret({
        request: c.text,
        room,
        platform: c.platform ?? 'room',
        ai: aiCall,
      });
    } catch (e) {
      if (!(e instanceof Skipped)) throw e;
      skipped++;
      continue;
    }
    const why = forbidden(d, c.forbid) ?? matches(shape(d), c.expect);
    const tag = why ? 'FAIL' : 'ok  ';
    console.log(
      `${tag} ${String(i + 1).padStart(3)} ${c.text}${why ? `\n       ${why}\n       got ${JSON.stringify(shape(d))}` : ''}`,
    );
    if (why)
      failed.push({
        text: c.text,
        why,
        got: shape(d),
        ...(c.note ? { note: c.note } : {}),
      });
  }
  const scored = cases.length - skipped;
  const passed = scored - failed.length;
  if (skipped) console.log(`\n${skipped} skipped (no cached AI answer)`);
  console.log(
    `\n${passed}/${scored} correct (${Math.round((passed / Math.max(1, scored)) * 100)}%)`,
  );
  writeFileSync(
    REPORT_FILE,
    JSON.stringify(
      { at: new Date().toISOString(), passed, total: scored, skipped, failed },
      null,
      2,
    ),
  );
  console.log(`report: ${REPORT_FILE}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
