export type Role = 'admin' | 'user';

export interface User {
  userId: string;
  socketId: string;
  name: string;
  role: Role;
  color: string; // Hex code for avatar background
  canPlay: boolean;    // Designated player/source of music
  canControl: boolean; // Permission to reorder/skip/pause
  canDj: boolean;      // Permission to use DJ soundboard
}


export interface Track {
  trackId: string;
  youtubeUrl: string;
  title: string;
  thumbnail: string;
  duration: number; // in seconds
  addedBy: string; // userId
  hearts: string[]; // List of userIds who liked this track
  addedAt: number; // timestamp when added
  message?: string; // Optional TTS message when track plays
  voicePreset?: string; // Optional voice preset for TTS (normal, robot, chipmunk, etc.)
}


export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number; // last sync time in seconds
  lastUpdated: number; // timestamp of last update
}

export interface ActivityLog {
  id: string;
  timestamp: number;
  type: 'user_join' | 'user_leave' | 'track_add' | 'track_remove' | 'track_skip' |
  'track_heart' | 'admin_transfer' | 'permission_change' | 'reaction' | 'queue_reorder';
  userId: string;
  userName: string;
  message: string;
  metadata?: Record<string, any>;
}

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  content: string;
  timestamp: number;
}

export interface Room {
  roomId: string;
  adminId: string;
  users: User[];
  queue: Track[];
  currentTrack: Track | null;
  playbackState: PlaybackState;
  skipVotes: string[]; // List of userIds who voted to skip current track
  activityLogs: ActivityLog[];
}

export interface RoomStateUpdate extends Omit<Room, 'users'> {
  users: Omit<User, 'socketId'>[];
}
