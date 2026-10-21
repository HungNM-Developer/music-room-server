import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import type { Lang, SpeechView, Voice } from '../contracts';
import { ENV, type Env } from '../config/env';
import { hasVietnameseMarks } from './tts-lang';
import { EdgeTtsProvider, type TtsProvider, VOICE_NAMES } from './tts.provider';

const AUDIO_MAX = 300;
const LANG_MAX = 1000;
const LANG_TIMEOUT_MS = 5000;
/** After a failed line, wait this long before trying it again (player commands are rebuilt often). */
const RETRY_AFTER_MS = 5 * 60_000;
/** Python processes at once (each holds tens of MB on a 512 MB server), and lines allowed to wait. */
const MAX_RUNNING = 2;
const MAX_WAITING = 20;

/** Over capacity: the line is simply read with the browser voice (not remembered as a failure). */
class Busy extends Error {}

/** For GET /api/health: whether Edge voices work here, and how the last lines went. */
export interface TtsStatus {
  /** disabled: TTS_ENABLED=false; checking: boot check running; off: cannot run here. */
  state: 'disabled' | 'checking' | 'off' | 'ready';
  /** Why it is off (Python too old, package missing). */
  reason?: string;
  /** Lines made / failed since the server started. */
  ok: number;
  failed: number;
  lastOkAt: string | null;
  /** edge-tts's own last error line (never the text being read). */
  lastError: string | null;
  lastErrorAt: string | null;
}

const LANG_SYSTEM =
  'You detect the language of a short message that will be read aloud. ' +
  'Reply with JSON only: {"lang":"vi"} for Vietnamese (also when written without accents), ' +
  '{"lang":"en"} for English, {"lang":"other"} for any other language.';

/**
 * Wishes and MC lines as Edge mp3. Audio is made ahead (when the wish is saved / the MC
 * line is written), kept in memory by key and served at GET /api/tts/<key>.mp3. Nothing
 * here may hold up a song: callers never wait, and a missing audio means "browser voice".
 */
@Injectable()
export class TtsService implements OnModuleInit {
  private readonly logger = new Logger(TtsService.name);
  private readonly provider: TtsProvider;
  /** False when edge-tts cannot run here (no Python 3.10+, package not installed): the browser voice is used. */
  private usable: Promise<boolean> = Promise.resolve(false);
  /** Same answer, readable without waiting (false until the boot check passed). */
  private ready = false;
  private readonly audio = new Map<string, Buffer>();
  private readonly langs = new Map<string, Lang>();
  private readonly running = new Map<string, Promise<string | null>>();
  private readonly failedAt = new Map<string, number>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private checked = false;
  private offReason: string | null = null;
  private readonly stats = {
    ok: 0,
    failed: 0,
    lastOkAt: null as number | null,
    lastError: null as string | null,
    lastErrorAt: null as number | null,
  };

  constructor(
    private readonly ai: AiService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.provider = new EdgeTtsProvider(env.TTS_PYTHON);
  }

  onModuleInit(): void {
    if (this.env.TTS_ENABLED === 'false') return;
    this.usable = this.provider.check().then((why) => {
      this.checked = true;
      this.offReason = why;
      if (why)
        this.logger.warn(
          `Edge TTS off: ${why}. Run \`npm run tts:install\` with TTS_PYTHON set to Python 3.10+; the speaker uses the browser voice meanwhile.`,
        );
      else this.logger.log('Edge TTS ready');
      this.ready = !why;
      return !why;
    });
  }

  /**
   * What the speaker reads now: audio if it is ready; else null, made in the background, with
   * `pending` while that runs (the caller re-sends once `whenReady` resolves with a key).
   */
  speech(text: string, voice: Voice): SpeechView {
    const lang = this.langs.get(text) ?? 'vi';
    const key = this.keyFor(text, VOICE_NAMES[lang][voice]);
    if (this.langs.has(text) && this.audio.has(key))
      return { text, audio: key, lang };
    void this.prepare(text, voice);
    const pending = this.ready && this.running.has(`${voice}\n${text}`);
    return { text, audio: null, lang, ...(pending ? { pending } : {}) };
  }

  /** The key once a running job for this line finishes (null: none running, or it failed). */
  whenReady(text: string, voice: Voice): Promise<string | null> {
    return this.running.get(`${voice}\n${text}`) ?? Promise.resolve(null);
  }

  /** Makes (or finds) the mp3 for a line; its key, or null when TTS is off or Edge failed. */
  prepare(text: string, voice: Voice): Promise<string | null> {
    if (this.env.TTS_ENABLED === 'false' || !text.trim())
      return Promise.resolve(null);
    const id = `${voice}\n${text}`;
    const running = this.running.get(id);
    if (running) return running;
    if (Date.now() - (this.failedAt.get(id) ?? 0) < RETRY_AFTER_MS)
      return Promise.resolve(null);
    const job = (async () => {
      try {
        const key = await this.make(text, voice);
        if (key) this.failedAt.delete(id);
        else this.failedAt.set(id, Date.now());
        while (this.failedAt.size > LANG_MAX)
          this.failedAt.delete(this.failedAt.keys().next().value as string);
        return key;
      } catch (e) {
        // Busy: no free slot, so this line uses the browser voice; it may be tried again later.
        if (!(e instanceof Busy))
          this.logger.warn(`Edge TTS failed: ${String(e)}`);
        return null;
      } finally {
        this.running.delete(id);
      }
    })();
    this.running.set(id, job);
    return job;
  }

  get(key: string): Buffer | undefined {
    return this.audio.get(key);
  }

  status(): TtsStatus {
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
    const state: TtsStatus['state'] =
      this.env.TTS_ENABLED === 'false'
        ? 'disabled'
        : !this.checked
          ? 'checking'
          : this.offReason
            ? 'off'
            : 'ready';
    return {
      state,
      ...(state === 'off' && this.offReason ? { reason: this.offReason } : {}),
      ok: this.stats.ok,
      failed: this.stats.failed,
      lastOkAt: iso(this.stats.lastOkAt),
      lastError: this.stats.lastError,
      lastErrorAt: iso(this.stats.lastErrorAt),
    };
  }

  private async make(text: string, voice: Voice): Promise<string | null> {
    if (!(await this.usable)) return null;
    const lang = await this.langOf(text);
    const voiceName = VOICE_NAMES[lang][voice];
    const key = this.keyFor(text, voiceName);
    if (this.audio.has(key)) return key;
    await this.slot();
    try {
      const mp3 = await this.provider.synthesize(text, voiceName);
      this.stats.ok += 1;
      this.stats.lastOkAt = Date.now();
      this.audio.set(key, mp3);
      while (this.audio.size > AUDIO_MAX)
        this.audio.delete(this.audio.keys().next().value as string);
      return key;
    } catch (e) {
      this.logger.warn(`Edge TTS (${voiceName}) failed: ${String(e)}`);
      this.stats.failed += 1;
      this.stats.lastErrorAt = Date.now();
      // The provider's message is edge-tts's last stderr line, never the text being read.
      this.stats.lastError =
        `${voiceName}: ${String(e).replace(/^Error: /, '')}`.slice(0, 300);
      return null;
    } finally {
      this.release();
    }
  }

  /** Waits for one of MAX_RUNNING slots; throws Busy when MAX_WAITING lines already wait. */
  private async slot(): Promise<void> {
    if (this.active < MAX_RUNNING) {
      this.active += 1;
      return;
    }
    if (this.waiting.length >= MAX_WAITING) throw new Busy();
    // release() hands its slot straight to the next waiter (active stays the same).
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }

  /** Marks → Vietnamese; no marks → ask the AI; no answer → Vietnamese; another language → English. */
  private async langOf(text: string): Promise<Lang> {
    const known = this.langs.get(text);
    if (known) return known;
    let lang: Lang = 'vi';
    if (!hasVietnameseMarks(text)) {
      const answer = await this.ai.json<{ lang?: string }>(
        'tts-lang',
        LANG_SYSTEM,
        text,
        {
          timeoutMs: LANG_TIMEOUT_MS,
        },
      );
      if (answer?.lang === 'en' || answer?.lang === 'other') lang = 'en';
    }
    this.langs.set(text, lang);
    while (this.langs.size > LANG_MAX)
      this.langs.delete(this.langs.keys().next().value as string);
    return lang;
  }

  private keyFor(text: string, voiceName: string): string {
    return createHash('sha256')
      .update(`${voiceName}\n${text}`)
      .digest('hex')
      .slice(0, 32);
  }
}
