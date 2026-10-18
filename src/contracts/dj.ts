import type { ErrorCode, ErrorParams } from './errors';
import type { TrackSummary } from './snapshot';

/**
 * "@DJ" in the room chat and "@Music Room" in Slack (spec 2026-10-18-dj-chat). The DJ answers
 * with this structure; each client words it in the viewer's language. AI never writes text
 * that is shown as is.
 */

/** Buttons "Chỉ cho tôi" can light up (`data-guide` on the client). */
export const GUIDE_TARGETS = [
  'skip',
  'save',
  'heart',
  'pause',
  'lyrics',
  'listen',
  'share',
  'mini',
  'add',
  'myItem',
  'block',
] as const;
export type GuideTarget = (typeof GUIDE_TARGETS)[number];

/** Questions the DJ answers from the room's state. */
export const INFO_KINDS = [
  'nowPlaying',
  'whoPicked',
  'myNext',
  'queueLength',
  'myCount',
] as const;
export type InfoKind = (typeof INFO_KINDS)[number];

export interface DjInfo {
  kind: InfoKind;
  /** nowPlaying / whoPicked: the song on air; null when nothing plays. */
  title?: string | null;
  pickedBy?: string | null;
  /** myNext: songs before the asker's next one, and when it should start (seconds from now). */
  ahead?: number;
  etaSec?: number | null;
  /** myNext: the asker's next song; absent = they have none waiting. */
  queueItemId?: string;
  /** queueLength / myCount. */
  count?: number;
  /** queueLength: total length in seconds; null when a song has no known length. */
  totalSec?: number | null;
}

/**
 * What the DJ does itself when a request holds several tasks (add many songs, add with a wish,
 * heart, remove, pin, skip…). A single task the asker can do stays a guide.
 */
export const DJ_ACTIONS = [
  'add',
  'heart',
  'remove',
  'pin',
  'skip',
  'vote',
  'pause',
  'resume',
] as const;
export type DjAction = (typeof DJ_ACTIONS)[number];

/** Why a step was not done when there is no error code for it. */
export type DjStepReason =
  | 'notFound'
  | 'notMine'
  | 'nothingPlaying'
  | 'busy'
  | 'oneHeart'
  | 'alreadyHearted'
  /** heart: the only matches were the asker's own songs. */
  | 'ownSong'
  /** add: more songs asked for than one request brings (`wanted`); `got` = that limit. */
  | 'tooMany';

export interface DjStep {
  action: DjAction;
  ok: boolean;
  track?: TrackSummary;
  queueItemId?: string;
  /** add: place in the queue (1 = next; 0 = playing now) and when it should start. */
  position?: number;
  etaSec?: number | null;
  /** add: the wish sent with the song. */
  wish?: string;
  /** add: a real "newest / trending" lookup. */
  fresh?: 'latest' | 'popular' | null;
  /** pin: to play it now ("phát ngay", "skip đến …"), not only next; also on a failed pin. */
  now?: boolean;
  /** Not done (or done differently): why. */
  reason?: DjStepReason;
  errorCode?: ErrorCode;
  errorParams?: ErrorParams;
  /** What was asked for, when nothing matched it. */
  query?: string;
  /** add, fewer than asked: how many went in of how many. */
  got?: number;
  wanted?: number;
}

export type DjReplyKind =
  | 'guide'
  | 'info'
  | 'added'
  | 'done'
  | 'hello'
  | 'other'
  | 'busy'
  | 'denied'
  | 'error';

export interface DjReply {
  kind: DjReplyKind;
  /** Who asked: "bạn" for them, their name for everyone else. */
  forMemberId: string;
  forName: string;
  /** guide */
  guide?: GuideTarget;
  /** guide add: the song name to put in the search box. */
  query?: string;
  /** guide myItem / added: the queue item. */
  queueItemId?: string;
  info?: DjInfo;
  /**
   * added: the song, its place in the queue (1 = next; 0 = it started at once, the room was
   * idle) and when it should start.
   */
  track?: TrackSummary;
  position?: number;
  etaSec?: number | null;
  /** added: a real "newest / trending" lookup succeeded; null = a plain search. */
  fresh?: 'latest' | 'popular' | null;
  /** done: each task, in order. */
  steps?: DjStep[];
  /** denied / error / busy */
  errorCode?: ErrorCode;
  errorParams?: ErrorParams;
  retryAfterSec?: number;
}
