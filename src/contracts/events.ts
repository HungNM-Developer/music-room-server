import type { ThemeId } from './constants';
import type { ErrorCode } from './errors';
import type {
  ActivityLogView,
  BlockedTrackView,
  ChatMessageView,
  DjEvent,
  LibraryItemView,
  LyricsView,
  MyRoomView,
  RoomStatusView,
  PlaylistSummaryView,
  PlaylistView,
  YouTubePlaylistView,
  UserView,
  RecapView,
  SuggestionView,
  PlayerCommand,
  PlayerRevokeReason,
  ReactionEvent,
  RevokeReason,
  RoomSnapshot,
  SongListItemView,
  SongListStop,
  TrackSummary,
} from './snapshot';

/** Ack payloads returned by commands that carry data. Others return {}. */
export interface CommandResults {
  'room:create': { token: string; code: string; memberId: string };
  /**
   * `rejoined`: the name belonged to an offline member and this is them again.
   * `rightsReset`: coming back by name dropped their control / DJ / player rights.
   */
  'room:join': {
    token: string;
    code: string;
    memberId: string;
    rejoined: boolean;
    rightsReset: boolean;
  };
  'room:peek': {
    name: string;
    memberCount: number;
    onlineCount: number;
    theme: ThemeId;
  };
  'host:register': { token: string; code: string; memberId: string };
  'queue:add': {
    queueItemId: string;
    title: string;
    /** Someone else had queued it: the member's heart went to that copy instead. */
    upvoted?: boolean;
  };
  /**
   * `library`: songs this server already knows (no quota); `cache`: an earlier YouTube
   * search for the same words; `youtube`: a fresh YouTube search.
   */
  'search:query': {
    /** This page's results (YouTube's order); a later page continues the list. */
    results: TrackSummary[];
    source: 'library' | 'cache' | 'youtube';
    /** YouTube has more results: "Xem thêm" asks for the next page. */
    more?: boolean;
  };
  'library:room': { items: LibraryItemView[] };
  /** Admin only: the room's blocked videos, most recently blocked first. */
  'track:blocked': { items: BlockedTrackView[] };
  'suggest:next': { items: SuggestionView[] };
  'wish:suggest': { text: string };
  'auth:google': { token: string; user: UserView };
  'auth:me': { user: UserView | null };
  'me:rooms': { rooms: MyRoomView[] };
  /** Rooms that no longer exist are left out. */
  'rooms:status': { rooms: RoomStatusView[] };
  'me:favorites-import': { imported: number };
  'playlist:mine': { playlists: PlaylistSummaryView[] };
  'playlist:create': { id: string };
  'playlist:get': PlaylistView;
  'playlist:share': { shareCode: string | null };
  'playlist:copy': { id: string };
  /** `likedImportedId`: our playlist made from the liked videos, if any. */
  'youtube:library': {
    playlists: YouTubePlaylistView[];
    likedImportedId: string | null;
  };
  /** `topArtists`: display names, best first. */
  'taste:for-me': { items: SuggestionView[]; topArtists: string[] };
  'taste:save-mix': { playlistId: string; count: number };
  'youtube:import': {
    playlistId: string;
    name: string;
    imported: number;
    skipped: number;
  };
  'room:recap': RecapView;
  'playlist:open': { playlistId: string; tracks: TrackSummary[] };
  /**
   * One item per line, in order. `stopped`: why some lines are still `later`
   * (`seconds` until the member may search YouTube again, when known).
   */
  'songlist:match': { items: SongListItemView[]; stopped: SongListStop | null };
  /** Skipped songs say why (ALREADY_QUEUED, PLAYED_RECENTLY, TRACK_TOO_LONG, QUEUE_LIMIT…). */
  'queue:add-many': {
    added: number;
    skipped: { trackId: string; reason: ErrorCode }[];
  };
  /** null when no lyrics were found. */
  'lyrics:get': { lyrics: LyricsView | null };
  'favorite:set': { saved: boolean };
  /** Newest first. */
  'favorite:list': { tracks: TrackSummary[] };
  /** In the order asked; ids that cannot be found are left out. */
  'tracks:lookup': { tracks: TrackSummary[] };
}

/** Server → client events. */
export interface ServerEvents {
  'session:ready': (data: { memberId: string; code: string }) => void;
  'session:revoked': (data: { reason: RevokeReason }) => void;
  'room:update': (snapshot: RoomSnapshot) => void;
  'chat:history': (messages: ChatMessageView[]) => void;
  'chat:receive': (message: ChatMessageView) => void;
  'activity:history': (logs: ActivityLogView[]) => void;
  'activity:new': (log: ActivityLogView) => void;
  'room:reaction': (event: ReactionEvent) => void;
  'dj:event': (event: DjEvent) => void;
  'player:command': (command: PlayerCommand) => void;
  'player:revoked': (data: { reason: PlayerRevokeReason }) => void;
  /** Only to the member's own sockets: on joining and after every save / unsave. */
  'favorite:ids': (data: { trackIds: string[] }) => void;
  /** To every socket of the account: one of its playlists changed (null id: the list itself). */
  'playlist:changed': (data: { playlistId: string | null }) => void;
}

export const ACK_TIMEOUT_MS = 8000;
export const PLAYER_PROGRESS_INTERVAL_MS = 5000;
export const PLAYER_LEASE_MS = 20000;
