import { z } from 'zod';
import {
  DJ_SOUNDS,
  ADD_MANY_MAX,
  LIBRARY_SORTS,
  LIMITS,
  LOOKUP_MAX_IDS,
  MAX_PLAYLIST_TRACKS,
  SHARE_CODE,
  PIN_PATTERN,
  PLAYER_ERROR_CODES,
  REACTIONS,
  THEME_IDS,
  SEARCH_MAX_RESULTS,
  SEARCH_PAGE_SIZE,
  VOICE_PRESETS,
  VOICES,
} from './constants';
import {
  cleanLine,
  cleanMultiline,
  normalizeRoomCode,
  ROOM_CODE_PATTERN,
} from './text';
import { SONGLIST_LINE_MAX, SONGLIST_MAX_LINES } from './songlist';
import { parseYouTubePlaylist, VIDEO_ID } from './youtube';

const line = (max: number, min = 1) =>
  z
    .string()
    .max(LIMITS.rawText)
    .transform(cleanLine)
    .pipe(z.string().min(min).max(max));

const multiline = (max: number, min = 1) =>
  z
    .string()
    .max(LIMITS.rawText)
    .transform(cleanMultiline)
    .pipe(z.string().min(min).max(max));

/** Interface languages; each device picks its own (stored on the client only). */
export const LANGS = ['vi', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const LangSchema = z.enum(LANGS);

export const RoomNameSchema = line(LIMITS.roomName);
export const DisplayNameSchema = line(LIMITS.displayName);
export const RoomCodeSchema = z
  .string()
  .max(32)
  .transform(normalizeRoomCode)
  .pipe(z.string().regex(ROOM_CODE_PATTERN));
const Id = z.string().min(1).max(64);
const TrackIdSchema = z.string().regex(/^youtube:[A-Za-z0-9_-]{11}$/);
const AccessToken = z.string().min(20).max(4096);
export const PinSchema = z.string().regex(PIN_PATTERN);

export const ThemeIdSchema = z.enum(THEME_IDS);

export const RoomSettingsSchema = z.strictObject({
  skipThreshold: z.number().min(0.1).max(1),
  /** V1: seconds a skip vote stays open. */
  skipVoteWindowSec: z.number().int().min(10).max(60),
  maxQueuedPerMember: z.number().int().min(1).max(20),
  maxTrackDurationSec: z
    .number()
    .int()
    .refine((v) => v === 0 || (v >= 60 && v <= 7200)),
  fallbackPlaylistUrl: z
    .string()
    .max(LIMITS.input)
    .nullable()
    .refine((v) => v === null || parseYouTubePlaylist(v) !== null),
  allowGuestDj: z.boolean(),
  /** A4: when the queue is empty, keep playing songs like the last one (known songs only). */
  autoRadio: z.boolean(),
  /** A6: a song cannot be added again within this many minutes of starting (0 = off). */
  repeatGapMinutes: z.number().int().min(0).max(1440),
  /** AI3: the speaker reads a short radio-style intro before members' songs. */
  mcIntro: z.boolean(),
  /** The room's theme: everyone's default, and always the speaker screen's. */
  theme: ThemeIdSchema,
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;

export const DEFAULT_SETTINGS: RoomSettings = {
  skipThreshold: 0.5,
  skipVoteWindowSec: 20,
  maxQueuedPerMember: 4,
  maxTrackDurationSec: 600,
  fallbackPlaylistUrl: null,
  allowGuestDj: false,
  autoRadio: false,
  repeatGapMinutes: 60,
  mcIntro: false,
  theme: 'default',
};

/** Client → server command payloads. Every schema is strict: unknown keys are rejected (R-09, R-42). */
export const C2S = {
  'room:create': z.strictObject({
    name: RoomNameSchema,
    displayName: DisplayNameSchema,
    adminPin: PinSchema,
  }),
  'room:peek': z.strictObject({ code: RoomCodeSchema }),
  /**
   * A name held by an offline member brings that member back; an offline admin also
   * needs `adminPin` (PIN_REQUIRED otherwise).
   */
  'room:join': z.strictObject({
    code: RoomCodeSchema,
    /** Optional when signed in (the account's member or Google name is used). */
    displayName: DisplayNameSchema.optional(),
    adminPin: PinSchema.optional(),
  }),
  'room:leave': z.strictObject({}),
  /** The room's owner only (signed in); `code` must be this room's code (typed to confirm). */
  'room:delete': z.strictObject({ code: RoomCodeSchema }),
  /** Same from the home page ("Phòng của tôi"): the signed-in account must own the room. */
  'me:room-delete': z.strictObject({ code: RoomCodeSchema }),
  /** Any member who knows the room's PIN becomes admin. */
  'admin:claim': z.strictObject({ pin: PinSchema }),
  /** Admin only: set or change the room's PIN. */
  'room:set-pin': z.strictObject({ pin: PinSchema }),
  /** Anyone with the room code may open the speaker page (no PIN). */
  'host:register': z.strictObject({ code: RoomCodeSchema }),
  'player:claim': z.strictObject({}),
  /** Keeps the lease alive while the room is idle (no item to report progress on). */
  'player:heartbeat': z.strictObject({}),
  'queue:add': z.strictObject({
    input: z.string().trim().min(1).max(LIMITS.input),
    wishMessage: multiline(LIMITS.wish, 0).optional(),
    voice: z.enum(VOICES).optional(),
    /** Older clients still send it; the value is ignored. */
    voicePreset: z.enum(VOICE_PRESETS).optional(),
  }),
  'queue:remove': z.strictObject({ queueItemId: Id }),
  'queue:pin-next': z.strictObject({ queueItemId: Id }),
  'queue:heart': z.strictObject({ queueItemId: Id }),
  'queue:set-message': z.strictObject({
    queueItemId: Id,
    wishMessage: multiline(LIMITS.wish, 0),
    voice: z.enum(VOICES).optional(),
    /** Older clients still send it; the value is ignored. */
    voicePreset: z.enum(VOICE_PRESETS).optional(),
  }),
  /** V1: `approve` true (default) = ✅ skip, false = ❌ keep listening (only while a vote is open). */
  'queue:vote-skip': z.strictObject({
    queueItemId: Id,
    approve: z.boolean().optional(),
  }),
  /** `remote: true` skips the server library and asks YouTube (costs search quota). */
  'search:query': z.strictObject({
    q: line(LIMITS.query),
    remote: z.boolean().optional(),
    /** "Xem thêm": 0 = the first SEARCH_PAGE_SIZE results, 1 = the next ones, … */
    page: z
      .number()
      .int()
      .min(0)
      .max(SEARCH_MAX_RESULTS / SEARCH_PAGE_SIZE - 1)
      .optional(),
  }),
  'playback:control': z.strictObject({
    action: z.enum(['play', 'pause', 'skip', 'seek']),
    queueItemId: Id,
    positionSec: z.number().min(0).max(86_400).optional(),
  }),
  'player:report': z.strictObject({
    queueItemId: Id,
    event: z.enum(['started', 'progress', 'ended', 'error']),
    positionSec: z.number().min(0).max(86_400).optional(),
    errorCode: z
      .number()
      .int()
      .refine((c) => (PLAYER_ERROR_CODES as readonly number[]).includes(c))
      .optional(),
  }),
  'permission:set': z
    .strictObject({
      memberId: Id,
      canPlay: z.boolean().optional(),
      canControl: z.boolean().optional(),
      canDj: z.boolean().optional(),
      role: z.enum(['ADMIN', 'USER']).optional(),
    })
    .refine(
      (p) =>
        p.canPlay !== undefined ||
        p.canControl !== undefined ||
        p.canDj !== undefined ||
        p.role !== undefined,
    ),
  'member:kick': z.strictObject({ memberId: Id }),
  'room:settings': RoomSettingsSchema.partial().refine(
    (s) => Object.keys(s).length > 0,
  ),
  'chat:send': z.strictObject({ content: multiline(LIMITS.chat) }),
  'room:reaction': z.strictObject({ emoji: z.enum(REACTIONS) }),
  'dj:trigger': z.strictObject({ soundType: z.enum(DJ_SOUNDS) }),
  /** L1: sign in with a Google ID token (Google Identity Services). */
  'auth:google': z.strictObject({ credential: z.string().min(20).max(4096) }),
  /** L1: the account this socket is signed in with, if any. */
  'auth:me': z.strictObject({}),
  /** L6: rooms the signed-in user owns or has joined. */
  'me:rooms': z.strictObject({}),
  /** Rooms this device remembers (not signed in): name, who is online, the song on air. */
  'rooms:status': z.strictObject({
    codes: z.array(RoomCodeSchema).min(1).max(20),
  }),
  /** L1: songs saved on this device before signing in, added to the account. */
  'me:favorites-import': z.strictObject({
    videoIds: z.array(z.string().regex(VIDEO_ID)).max(300),
  }),
  /** L2: personal playlists (signed in), and shared ones by code. */
  'playlist:mine': z.strictObject({ trackId: TrackIdSchema.optional() }),
  'playlist:create': z.strictObject({
    name: line(LIMITS.playlistName),
    trackIds: z.array(TrackIdSchema).max(MAX_PLAYLIST_TRACKS).optional(),
  }),
  'playlist:update': z
    .strictObject({
      id: Id,
      name: line(LIMITS.playlistName).optional(),
      description: line(LIMITS.playlistDescription, 0).optional(),
    })
    .refine((p) => p.name !== undefined || p.description !== undefined),
  'playlist:delete': z.strictObject({ id: Id }),
  'playlist:set-track': z.strictObject({
    id: Id,
    trackId: TrackIdSchema,
    saved: z.boolean(),
  }),
  'playlist:move': z.strictObject({
    id: Id,
    trackId: TrackIdSchema,
    to: z.number().int().min(0).max(MAX_PLAYLIST_TRACKS),
  }),
  'playlist:get': z.union([
    z.strictObject({ id: Id }),
    z.strictObject({ shareCode: z.string().regex(SHARE_CODE) }),
  ]),
  'playlist:share': z.strictObject({ id: Id, enabled: z.boolean() }),
  'playlist:copy': z.strictObject({ shareCode: z.string().regex(SHARE_CODE) }),
  /** L5: suggestions from the signed-in user's own taste. */
  'taste:for-me': z.strictObject({}),
  /** L5: keep the current "Dành cho bạn" picks as a personal playlist (updated on every save). */
  'taste:save-mix': z.strictObject({}),
  /** L3: the user's YouTube playlists, read with their own short-lived access token. */
  'youtube:library': z.strictObject({ accessToken: AccessToken }),
  /** L3: liked videos or one YouTube playlist → a personal playlist (re-import updates it). */
  'youtube:import': z.strictObject({
    accessToken: AccessToken,
    source: z.union([
      z.literal('liked'),
      z.string().regex(/^[A-Za-z0-9_-]{10,64}$/),
    ]),
    musicOnly: z.boolean(),
  }),
  /**
   * "Nhờ MC viết": a wish written by the AI for the sender to edit — for one of my waiting
   * songs (`queueItemId`) or a song not added yet (`title` / `artist`, adding with a wish).
   * `hint`: what the sender already typed (kept, names included); `language`: the sender's.
   */
  'wish:suggest': z
    .strictObject({
      queueItemId: Id.optional(),
      title: line(LIMITS.input).optional(),
      artist: line(LIMITS.input).optional(),
      hint: multiline(LIMITS.wish, 0).optional(),
      language: LangSchema.optional(),
    })
    .refine((v) => v.queueItemId !== undefined || v.title !== undefined, {
      message: 'queueItemId or title',
    }),
  /** A8: what the room played since `since` (at most 31 days back). */
  'room:recap': z.strictObject({
    since: z.iso.datetime(),
    tzOffsetMinutes: z.number().int().min(-840).max(840),
    /** The reader's language for the AI summary (default 'vi'). */
    language: LangSchema.optional(),
  }),
  /** A5: the playable songs of a YouTube playlist link. */
  'playlist:open': z.strictObject({
    url: z
      .string()
      .max(LIMITS.input)
      .refine((v) => parseYouTubePlaylist(v) !== null),
  }),
  /** N1: this device plays the room for itself ("Nghe cùng") — or stops. */
  'listen:set': z.strictObject({ on: z.boolean() }),
  /**
   * N1: this listener's player cannot play the song on air ("Video unavailable"). The server
   * asks YouTube again and skips the song only when it really does not play here.
   */
  'listen:unplayable': z.strictObject({
    queueItemId: Id,
    errorCode: z
      .number()
      .int()
      .refine((c) => (PLAYER_ERROR_CODES as readonly number[]).includes(c)),
  }),
  /** L4: find a song for each pasted line (free sources first, then YouTube search). */
  'songlist:match': z.strictObject({
    lines: z.array(line(SONGLIST_LINE_MAX)).min(1).max(SONGLIST_MAX_LINES),
  }),
  /** A5: add several known songs in order, until the member's queue limit. */
  'queue:add-many': z.strictObject({
    trackIds: z
      .array(z.string().regex(/^youtube:[A-Za-z0-9_-]{11}$/))
      .min(1)
      .max(ADD_MANY_MAX),
  }),
  /** A7: lyrics for a song (LRCLIB), synced to the music when available. */
  'lyrics:get': z.strictObject({
    trackId: z.string().regex(/^youtube:[A-Za-z0-9_-]{11}$/),
  }),
  /** A3: songs to play next, for the song on air unless `trackId` is given. */
  'suggest:next': z.strictObject({
    trackId: z
      .string()
      .regex(/^youtube:[A-Za-z0-9_-]{11}$/)
      .optional(),
  }),
  /** A1: songs this room has played, grouped by track. */
  'library:room': z.strictObject({ sort: z.enum(LIBRARY_SORTS) }),
  /** Admin only: block a video in the room (skips / removes it), unblock it, list them. */
  'track:block': z.strictObject({ trackId: TrackIdSchema }),
  'track:unblock': z.strictObject({ trackId: TrackIdSchema }),
  'track:blocked': z.strictObject({}),
  /** A2: save / unsave a song ("Lưu"). Idempotent. */
  'favorite:set': z.strictObject({
    trackId: z.string().regex(/^youtube:[A-Za-z0-9_-]{11}$/),
    saved: z.boolean(),
  }),
  'favorite:list': z.strictObject({}),
  /** Name and artwork for video ids saved on this device in other rooms. */
  'tracks:lookup': z.strictObject({
    videoIds: z.array(z.string().regex(VIDEO_ID)).min(1).max(LOOKUP_MAX_IDS),
  }),
} as const;

export type CommandName = keyof typeof C2S;
export type CommandPayload<K extends CommandName> = z.input<(typeof C2S)[K]>;
export type CommandInput<K extends CommandName> = z.output<(typeof C2S)[K]>;

/** Commands a socket may send before it is bound to a member. */
export const ANONYMOUS_COMMANDS: readonly CommandName[] = [
  'room:create',
  'room:peek',
  'room:join',
  'host:register',
  'auth:google',
  'auth:me',
  'me:rooms',
  'rooms:status',
  'me:room-delete',
  'me:favorites-import',
  'playlist:mine',
  'playlist:create',
  'playlist:update',
  'playlist:delete',
  'playlist:set-track',
  'playlist:move',
  'playlist:get',
  'playlist:share',
  'playlist:copy',
  'youtube:library',
  'youtube:import',
  'taste:for-me',
  'taste:save-mix',
];
