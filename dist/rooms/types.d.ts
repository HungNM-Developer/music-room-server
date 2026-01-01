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
}
export interface PlaybackState {
    isPlaying: boolean;
    currentTime: number;
    lastUpdated: number;
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
