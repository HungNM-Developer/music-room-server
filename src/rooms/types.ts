export type Role = 'admin' | 'user';

export interface User {
  userId: string;
  socketId: string;
  name: string;
  role: Role;
  color: string; // Hex code for avatar background
}

export interface Track {
  trackId: string;
  youtubeUrl: string;
  title: string;
  thumbnail: string;
  duration: number; // in seconds
  addedBy: string; // userId
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number; // last sync time in seconds
  lastUpdated: number; // timestamp of last update
}

export interface Room {
  roomId: string;
  adminId: string;
  users: User[];
  queue: Track[];
  currentTrack: Track | null;
  playbackState: PlaybackState;
}

export interface RoomStateUpdate extends Omit<Room, 'users'> {
    users: Omit<User, 'socketId'>[];
}
