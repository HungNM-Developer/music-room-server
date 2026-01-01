import { Room, User, Track, PlaybackState } from './types';
export declare class RoomsService {
    private rooms;
    private timers;
    private onTrackEndCallback;
    private colors;
    setTrackEndCallback(callback: (roomId: string) => void): void;
    private getRandomColor;
    createRoom(adminName: string, socketId: string): Room;
    joinRoom(roomId: string, name: string, socketId: string): {
        room: Room;
        user: User;
        error?: string;
    } | null;
    leaveRoom(socketId: string): {
        roomId: string;
        room: Room | null;
    } | null;
    getRoom(roomId: string): Room | undefined;
    fetchYoutubeMetadata(url: string): Promise<{
        title: string;
        thumbnail: string;
        duration: number;
    }>;
    addTrack(roomId: string, youtubeUrl: string, userId: string, duration?: number): Promise<{
        track: Track | null;
        error?: string;
    }>;
    removeTrack(roomId: string, trackId: string, userId: string): boolean;
    updatePlayback(roomId: string, userId: string, state: Partial<PlaybackState>): boolean;
    private startTrackTimer;
    private stopTrackTimer;
    reorderQueue(roomId: string, userId: string, fromIndex: number, toIndex: number): boolean;
    transferAdmin(roomId: string, currentAdminId: string, newAdminId: string): boolean;
    setControlPermission(roomId: string, requesterId: string, targetUserId: string, canControl: boolean): boolean;
    setPlayerPermission(roomId: string, requesterId: string, targetUserId: string): boolean;
    nextTrack(roomId: string): Track | null;
    heartTrack(roomId: string, trackId: string, userId: string): boolean;
}
