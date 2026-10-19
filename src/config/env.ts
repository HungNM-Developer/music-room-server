import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const httpUrl = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//.test(v));

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().refine((v) => /^postgres(ql)?:\/\//.test(v)),
  PUBLIC_URL: httpUrl,
  YOUTUBE_API_KEY: optionalString,
  /**
   * Song search on YouTube: `innertube` asks YouTube's own web search (no API quota; the
   * Data API then only checks the videos, 1 unit) and falls back to the API search;
   * `api` uses the Data API search only (100 units a search).
   */
  YOUTUBE_SEARCH_PROVIDER: z.enum(['innertube', 'api']).default('innertube'),
  /** L1: Google sign-in (OAuth client id, public). Without it sign-in is hidden. */
  GOOGLE_CLIENT_ID: optionalString,
  /** A3 / A4 / AI1: Last.fm similar tracks and canonical names (free key). */
  LASTFM_API_KEY: optionalString,
  /**
   * Free AI, tried in this order: Gemini → Groq → OpenRouter (each only with a key). Each
   * *_MODEL is a comma-separated list, tried in order: free quotas are per model, so when one
   * is spent for the day the next answers (AiService).
   */
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z
    .string()
    .default('gemini-flash-lite-latest,gemini-3.1-flash-lite'),
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: z
    .string()
    .default('qwen/qwen3.8-27b,openai/gpt-oss-20b,openai/gpt-oss-120b'),
  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_MODEL: optionalString,
  /** "@DJ": requests that need the AI, per member per hour (requests the rules answer are free). */
  DJ_AI_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(10),
  /** Đợt 3: the Slack app of this workspace ("/music"). Both needed; otherwise Slack is off. */
  SLACK_BOT_TOKEN: optionalString,
  SLACK_SIGNING_SECRET: optionalString,
  /** Slack Web API base; only changed to point at a local stand-in while testing. */
  SLACK_API_URL: httpUrl.default('https://slack.com/api'),
  /** Local time for the radio's "time of day" (AI5); the office's time zone. */
  ROOM_TIMEZONE: z.string().default('Asia/Ho_Chi_Minh'),
  JWT_SECRET: optionalString.refine((v) => v === undefined || v.length >= 32),
  DATA_DIR: z.string().default('/data'),
  /** Edge TTS voices for wishes and MC lines; 'false' = the speaker reads with the browser voice (Edge blocked). */
  TTS_ENABLED: z.enum(['true', 'false']).default('true'),
  /** Python 3.10+ that runs edge-tts; `npm run tts:install` must use the same one. */
  TTS_PYTHON: z.string().default('python3'),
  /** R-43: room:create / room:join / host:register per IP per minute. */
  JOIN_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(20),
  /** Orphan room cleanup: first run this long after boot, then every ORPHAN_SWEEP_EVERY_MS. */
  ORPHAN_SWEEP_FIRST_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(5 * 60_000),
  ORPHAN_SWEEP_EVERY_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(24 * 60 * 60_000),
  /**
   * Browser origins allowed besides PUBLIC_URL. Each entry is reduced to its origin, so
   * "https://app.vercel.app/" (trailing slash) still matches the browser's Origin header.
   */
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(
      z.array(httpUrl).transform((list) => list.map((u) => new URL(u).origin)),
    ),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export type Env = z.infer<typeof EnvSchema>;

const HINTS: Record<string, string> = {
  DATABASE_URL: 'phải là URL postgresql://…',
  PUBLIC_URL: 'phải là URL http/https',
  JWT_SECRET: 'tối thiểu 32 ký tự, hoặc để trống để tự sinh',
  PORT: 'phải là số cổng 1–65535',
  NODE_ENV: 'development | production | test',
  CORS_ORIGINS:
    'danh sách URL http/https ngăn bằng dấu phẩy, ví dụ https://app.vercel.app',
};

export class EnvError extends Error {}

/** Validates process.env once at boot; a bad value stops the server with a clear message (R-46). */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(raw);
  if (result.success) return result.data;
  const keys = [...new Set(result.error.issues.map((i) => String(i.path[0])))];
  throw new EnvError(
    keys
      .map(
        (k) =>
          `Biến môi trường không hợp lệ: ${k}${HINTS[k] ? ` (${HINTS[k]})` : ''}`,
      )
      .join('\n'),
  );
}

export const ENV = Symbol('ENV');
