import type { DjReply } from './dj';
import type { DjSound, Reaction, Voice, VoicePreset } from './constants';
import type { Lang, RoomSettings } from './schemas';

export type Role = 'ADMIN' | 'USER';
export type PlaybackStatus = 'IDLE' | 'PLAYING' | 'PAUSED';

export interface TrackSummary {
  id: string; // "youtube:<videoId>"
  provider: 'youtube';
  externalId: string;
  title: string;
  channel: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
  /** AI1: parsed from the title; null until known. */
  artist: string | null;
  song: string | null;
}

/** L1: a signed-in Google account. */
export interface UserView {
  id: string;
  name: string;
  email: string;
  picture: string | null;
}

/** L6: a room on "Phòng của tôi". */
export interface MyRoomView {
  code: string;
  name: string;
  isOwner: boolean;
  onlineCount: number;
  nowPlaying: string | null;
  lastVisitedAt: string;
}

/** A room this device remembers, as it is now (`rooms:status`). */
export interface RoomStatusView {
  code: string;
  name: string;
  onlineCount: number;
  /** Title of the song on air. */
  nowPlaying: string | null;
}

/** L2: a playlist in a list. `hasTrack` answers "is this song in it?" for "Lưu vào…". */
export interface PlaylistSummaryView {
  id: string;
  name: string;
  trackCount: number;
  coverUrl: string | null;
  shared: boolean;
  updatedAt: string;
  hasTrack?: boolean;
  /** Made by the app (YouTube likes, "for you" mix): clients show its name in the reader's language. */
  kind?: PlaylistKind | null;
}

export type PlaylistKind = 'liked' | 'mix';

/** L3: one of the user's YouTube playlists. `importedId`: our playlist made from it. */
export interface YouTubePlaylistView {
  id: string;
  title: string;
  itemCount: number;
  thumbnailUrl: string | null;
  importedId: string | null;
}

/**
 * L4: what a pasted line became. `found`: a playable song; `notFound`: YouTube has
 * nothing playable; `later`: not searched yet (limit, quota or time); `unsupported`:
 * a link that is not a YouTube video (Spotify, …).
 */
export interface SongListItemView {
  line: string;
  status: 'found' | 'notFound' | 'later' | 'unsupported';
  track: TrackSummary | null;
}

export interface SongListStop {
  reason: 'RATE_LIMITED' | 'QUOTA_EXCEEDED' | 'SEARCH_UNAVAILABLE' | 'TIME';
  seconds?: number;
}

/** L2: a whole playlist. `shareCode` is only sent to its owner. */
export interface PlaylistView {
  id: string;
  name: string;
  description: string | null;
  owner: { name: string };
  isOwner: boolean;
  shareCode: string | null;
  tracks: TrackSummary[];
  kind?: PlaylistKind | null;
}

/** A7: `synced` lines carry their start time in seconds; `plain` is the text alone. */
export interface LyricsView {
  synced: { t: number; text: string }[] | null;
  plain: string | null;
}

/** Why a song is suggested (A3). */
export type SuggestionReason =
  /** YouTube's own "up next" for the song on air (or the songs just played). */
  | 'youtube'
  /** Nothing played lately: YouTube's trending music in Vietnam. */
  | 'trending'
  | 'similar'
  | 'room'
  | 'artist'
  | 'popular'
  | 'dj'
  /** L5: for one person — "Vì bạn hay nghe X", "Giống gu X", "Người cùng gu cũng thích". */
  | 'taste'
  | 'taste-similar'
  | 'peers';

/**
 * `track`: a song the server knows, added in one tap. `search`: a song Last.fm suggests
 * that has no YouTube video here yet ("Tìm & thêm" runs a normal search).
 */
export type SuggestionView =
  | {
      kind: 'track';
      track: TrackSummary;
      reason: SuggestionReason;
      /** L5: the artist behind a taste reason. */
      because?: string;
    }
  | { kind: 'search'; artist: string; song: string; reason: 'similar' | 'dj' };

/** A8: what a room played over a period. */
export interface RecapView {
  plays: number;
  minutes: number;
  skipped: number;
  topSongs: { track: TrackSummary; plays: number; hearts: number }[];
  topPickers: {
    member: { id: string; displayName: string };
    songs: number;
    hearts: number;
  }[];
  /** Songs started in each local hour, index 0–23. */
  byHour: number[];
  /** A one-line, light-hearted comment written by AI (null without AI). */
  summary: string | null;
}

export interface MemberView {
  id: string;
  displayName: string;
  color: string;
  role: Role;
  isDevice: boolean;
  canPlay: boolean;
  canControl: boolean;
  canDj: boolean;
  online: boolean;
  /** N1: playing the room on their own device ("Nghe cùng"), usually away from the office. */
  listening: boolean;
  /** L1: the picture of the Google account behind the member; null for guests. */
  avatarUrl: string | null;
  /** L1: signed in with Google (a real account behind the name). */
  verified: boolean;
  /** Đợt 3: acting from a linked Slack channel ("Lan (Slack)" when the name was taken). */
  viaSlack: boolean;
  /** L6: the member of the account that owns (keeps) the room. */
  owner: boolean;
}

/** A1: one song this room has played (PLAYED or SKIPPED), all its plays together. */
export interface LibraryItemView {
  track: TrackSummary;
  plays: number;
  /** Hearts over every play. */
  hearts: number;
  lastPlayedAt: string;
  /** Who added it last time; null = fallback playlist. */
  lastAddedBy: { id: string; displayName: string } | null;
}

export interface QueueItemView {
  id: string;
  track: TrackSummary;
  /** null = fallback playlist ("Playlist dự phòng"). */
  addedBy: { id: string; displayName: string } | null;
  /** Set when the room added it itself (addedBy is null): radio (A4) or fallback playlist. */
  auto: 'radio' | 'fallback' | null;
  hearts: number;
  heartedBy: string[];
  pinned: boolean;
  wishMessage: string | null;
  /** The wish voice the sender picked; null = none picked yet (no wish, or a wish from before voices). */
  voice?: Voice | null;
  /** What the speaker reads for this item's wish; only set on the song now playing. */
  wishSpeech?: SpeechView | null;
  addedAt: string;
}

export interface NowPlayingView {
  item: QueueItemView;
  status: Exclude<PlaybackStatus, 'IDLE'>;
  /** Position at `positionAt` (server epoch ms). Clients extrapolate while PLAYING. */
  positionSec: number;
  positionAt: number;
  /**
   * V1 skip vote. `votes` / `voters`: ✅ from online members; `against` / `againstVoters`: ❌.
   * `endsAt` (server epoch ms) while a vote is open; `blockedUntil` after a vote that kept the
   * song, until which no new vote can start.
   */
  skip: {
    votes: number;
    required: number;
    voters: string[];
    against: number;
    againstVoters: string[];
    openedBy: { id: string; displayName: string } | null;
    endsAt: number | null;
    blockedUntil: number | null;
  };
}

export interface RoomSnapshot {
  version: number;
  serverTime: number;
  /**
   * `hasPin`: an admin PIN is set, so members can reclaim admin with it.
   * `blockedTrackIds`: videos the admin blocked in this room (nobody can add them).
   * `ownerUserId`: the account that owns the room (only it may delete the room); null = no
   * owner yet, so the room is deleted after 30 days nobody uses it.
   */
  room: {
    code: string;
    name: string;
    settings: RoomSettings;
    hasPin: boolean;
    blockedTrackIds: string[];
    ownerUserId: string | null;
  };
  members: MemberView[];
  /** Upcoming items, already in play order (R-18). */
  queue: QueueItemView[];
  status: PlaybackStatus;
  nowPlaying: NowPlayingView | null;
  player: { memberId: string | null; online: boolean };
  searchEnabled: boolean;
  /** A free AI provider is configured (DJ, MC, smarter radio, recap comment). */
  aiEnabled: boolean;
}

/** A video the room's admin blocked (`track:blocked`). */
export interface BlockedTrackView {
  track: TrackSummary;
  /** The admin's name when they blocked it. */
  blockedByName: string;
  /** ISO time. */
  blockedAt: string;
}

export interface ChatMessageView {
  id: string;
  /** 'dj' for the DJ's answers. */
  memberId: string;
  displayName: string;
  /** Plain text (Vietnamese for the DJ: history, speaker screen, Slack). */
  content: string;
  createdAt: string;
  /** The DJ's answer ("@DJ"): `dj` holds it in structure, worded per viewer. */
  kind?: 'dj';
  dj?: DjReply;
}

/**
 * What a log line is about, so each reader can word it in their own language. `variant` tells
 * apart the sentences of one `type` (the table lives in the server's ActivityService callers).
 */
export interface ActivityParams {
  variant?: string;
  title?: string;
  target?: string;
  targetDevice?: boolean;
  count?: number;
  yes?: number;
  no?: number;
  code?: number;
  actorDevice?: boolean;
}

export interface ActivityLogView {
  id: string;
  type: string;
  memberId: string | null;
  displayName: string | null;
  /** The Vietnamese sentence as stored; the fallback when `params` is missing (older lines). */
  message: string;
  params?: ActivityParams | null;
  createdAt: string;
}

export interface PlayerCommand {
  queueItemId: string | null;
  videoId: string | null;
  status: PlaybackStatus;
  positionSec: number;
  positionAt: number;
  /** Older clients read `wish` / `intro`; `voicePreset` is always null now. */
  wish: { message: string; voicePreset: VoicePreset | null } | null;
  /** AI3: the MC's line for this song, read when there is no wish. */
  intro: string | null;
  /** What to read before this song: the wish, else the MC line. */
  speech?: SpeechView | null;
}

/** A line for the speaker. `audio`: key of the Edge mp3 at /api/tts/<key>.mp3, null = not ready (read with the browser voice). */
export interface SpeechView {
  text: string;
  audio: string | null;
  lang: Lang;
  /** The mp3 is being made: hold the line a few seconds, it arrives in an updated command / snapshot. */
  pending?: boolean;
}

/** `room_deleted`: the room's owner deleted it (everyone is sent home). */
export type RevokeReason = 'kicked' | 'left' | 'invalid' | 'room_deleted';
export type PlayerRevokeReason = 'replaced' | 'permission' | 'kicked';

export interface ReactionEvent {
  emoji: Reaction;
  memberId: string;
}

export interface DjEvent {
  soundType: DjSound;
  memberId: string;
  displayName: string;
}

/** GET /api/rooms/:code/preview — public card for link previews and the share dialog. */
export interface RoomPreview {
  code: string;
  name: string;
  memberCount: number;
  nowPlaying: {
    title: string;
    channel: string | null;
    thumbnailUrl: string | null;
    addedBy: string | null;
  } | null;
}
