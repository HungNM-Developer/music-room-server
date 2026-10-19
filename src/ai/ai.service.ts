import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env';

/**
 * Free-tier AI, tried in order: Gemini → Groq → OpenRouter (each only with a key), every model
 * of a provider in turn (GEMINI_MODEL / GROQ_MODEL / OPENROUTER_MODEL take a comma-separated
 * list). Free quotas are counted per model: a model out of quota (429) or gone (404) rests and
 * the next model is tried; a bad key (401 / 403) rests every model of that provider. When none
 * answers the caller gets null and uses its non-AI path. Only song titles and channel names
 * are sent — free tiers may keep prompts.
 */

const TIMEOUT_MS = 15_000;
/** Rest when the provider does not say how long (or says less / more). */
const REST_MS = 10 * 60_000;
const REST_MIN_MS = 60_000;
/** A daily quota says "come back tomorrow": look again within the hour anyway. */
const REST_MAX_MS = 60 * 60_000;
/** Quota or unknown model: that model is useless for a while. */
const REST_MODEL_ON = [404, 429];
/** Bad key: every model of the provider. */
const REST_PROVIDER_ON = [401, 403];

export interface AiOptions {
  timeoutMs?: number;
  /** 0.2 for extraction, higher for writing (MC lines, DJ picks). */
  temperature?: number;
}

/** One model of one provider. */
interface Provider {
  /** "gemini", "groq", "openrouter". */
  name: string;
  model: string;
  call(
    system: string,
    user: string,
    opts: Required<AiOptions>,
  ): Promise<string>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    /** How long the provider asked us to wait (Retry-After, Gemini's retryDelay). */
    readonly retryAfterMs: number | null,
  ) {
    super(`HTTP ${status}`);
  }
}

/** Seconds from `Retry-After` or from Gemini's error body (`"retryDelay": "41s"`). */
function retryAfterMs(res: Response, body: string): number | null {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Number(m[1]) * 1000 : null;
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status, retryAfterMs(res, text));
  }
  return res.json();
}

/** "a, b,c" → ["a", "b", "c"] (a single name works too). */
export function modelList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    ),
  ];
}

/** OpenAI-compatible chat completions (Groq, OpenRouter). */
function chatCompletions(
  name: string,
  url: string,
  key: string,
  model: string,
): Provider {
  return {
    name,
    model,
    async call(system, user, opts) {
      const body = (await post(
        url,
        { authorization: `Bearer ${key}` },
        {
          model,
          temperature: opts.temperature,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        opts.timeoutMs,
      )) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content;
      if (!text) throw new Error('empty answer');
      return text;
    },
  };
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly providers: Provider[] = [];
  private readonly restingUntil = new Map<string, number>();

  constructor(@Inject(ENV) env: Env) {
    if (env.GEMINI_API_KEY) {
      const key = env.GEMINI_API_KEY;
      for (const model of modelList(env.GEMINI_MODEL))
        this.providers.push({
          name: 'gemini',
          model,
          async call(system, user, opts) {
            const body = (await post(
              `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
              { 'x-goog-api-key': key },
              {
                systemInstruction: { parts: [{ text: system }] },
                contents: [{ role: 'user', parts: [{ text: user }] }],
                generationConfig: {
                  temperature: opts.temperature,
                  responseMimeType: 'application/json',
                },
              },
              opts.timeoutMs,
            )) as {
              candidates?: { content?: { parts?: { text?: string }[] } }[];
            };
            const text = body.candidates?.[0]?.content?.parts
              ?.map((p) => p.text ?? '')
              .join('');
            if (!text) throw new Error('empty answer');
            return text;
          },
        });
    }
    if (env.GROQ_API_KEY)
      for (const model of modelList(env.GROQ_MODEL))
        this.providers.push(
          chatCompletions(
            'groq',
            'https://api.groq.com/openai/v1/chat/completions',
            env.GROQ_API_KEY,
            model,
          ),
        );
    if (env.OPENROUTER_API_KEY)
      for (const model of modelList(env.OPENROUTER_MODEL))
        this.providers.push(
          chatCompletions(
            'openrouter',
            'https://openrouter.ai/api/v1/chat/completions',
            env.OPENROUTER_API_KEY,
            model,
          ),
        );
    if (this.providers.length)
      this.logger.log(
        `AI models: ${this.providers.map((p) => `${p.name}/${p.model}`).join(' → ')}`,
      );
  }

  get enabled(): boolean {
    return this.providers.length > 0;
  }

  /** First provider that answers with valid JSON, or null. `task` only names it in logs. */
  async json<T>(
    task: string,
    system: string,
    user: string,
    options: AiOptions = {},
  ): Promise<T | null> {
    const opts = { timeoutMs: TIMEOUT_MS, temperature: 0.2, ...options };
    for (const p of this.providers) {
      const now = Date.now();
      if (
        (this.restingUntil.get(p.name) ?? 0) > now ||
        (this.restingUntil.get(`${p.name}/${p.model}`) ?? 0) > now
      )
        continue;
      try {
        const text = await p.call(system, user, opts);
        // Some models wrap JSON in ``` fences despite JSON mode.
        return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as T;
      } catch (e) {
        const rest = this.rest(p, e);
        this.logger.warn(
          `AI ${task} via ${p.name}/${p.model} failed (${String(e)})${rest ? `; resting ${rest}` : ''}`,
        );
      }
    }
    return null;
  }

  /** Sets the model (or, for a bad key, the provider) to rest; what rests, for the log. */
  private rest(p: Provider, e: unknown): string | null {
    if (!(e instanceof HttpError)) return null;
    const whole = REST_PROVIDER_ON.includes(e.status);
    if (!whole && !REST_MODEL_ON.includes(e.status)) return null;
    const ms = Math.min(
      REST_MAX_MS,
      Math.max(REST_MIN_MS, e.retryAfterMs ?? REST_MS),
    );
    const key = whole ? p.name : `${p.name}/${p.model}`;
    this.restingUntil.set(key, Date.now() + ms);
    return `${whole ? `every ${p.name} model` : 'it'} ${Math.round(ms / 60_000)} min`;
  }
}
