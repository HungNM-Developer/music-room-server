export type Role = 'admin' | 'user';
export interface User {
    userId: string;
    socketId: string;
    name: string;
    role: Role;
    color: string;
    canPlay: boolean;
    canControl: boolean;
}
export interface Track {
    trackId: string;
    youtubeUrl: string;
    title: string;
    thumbnail: string;
    duration: number;
    addedBy: string;
    hearts: string[];
    addedAt: number;
    message?: string;
    voicePreset?: string;
}
export interface PlaybackState {
    isPlaying: boolean;
    currentTime: number;
    lastUpdated: number;
}
export interface ActivityLog {
    id: string;
    timestamp: number;
    type: 'user_join' | 'user_leave' | 'track_add' | 'track_remove' | 'track_skip' | 'track_heart' | 'admin_transfer' | 'permission_change' | 'reaction' | 'queue_reorder';
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
    skipVotes: string[];
    activityLogs: ActivityLog[];
}
export interface RoomStateUpdate extends Omit<Room, 'users'> {
    users: Omit<User, 'socketId'>[];
}
