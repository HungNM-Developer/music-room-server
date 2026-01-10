import { Room, User, Track, PlaybackState, ActivityLog } from './types';
export declare class RoomsService {
    private rooms;
    private inactivityTimers;
    private trackEndTimers;
    private onTrackEndCallback;
    private onRoomClosedCallback;
    private onActivityLogCallback;
    private COLORS;
    setTrackEndCallback(callback: (roomId: string) => void): void;
    setRoomClosedCallback(callback: (roomId: string) => void): void;
    setActivityLogCallback(callback: (roomId: string, log: ActivityLog) => void): void;
    logActivity(roomId: string, type: ActivityLog['type'], userId: string, userName: string, message: string, metadata?: Record<string, any>): void;
    private resetInactivityTimer;
    private stopInactivityTimer;
    private closeRoom;
    private clearTrackTimer;
    private scheduleTrackEnd;
    private triggerTrackEnd;
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
    getRoom(roomId: string): Room | null;
    private getAdjustedRoom;
    fetchYoutubeMetadata(url: string): Promise<{
        title: string;
        thumbnail: string;
        duration: number;
    }>;
    addTrack(roomId: string, youtubeUrl: string, userId: string, duration?: number, message?: string): Promise<{
        track: Track | null;
        error?: string;
    }>;
    removeTrack(roomId: string, trackId: string, userId: string): boolean;
    updatePlayback(roomId: string, userId: string, state: Partial<PlaybackState>): boolean;
    reorderQueue(roomId: string, userId: string, fromIndex: number, toIndex: number): boolean;
    transferAdmin(roomId: string, currentAdminId: string, newAdminId: string): boolean;
    setControlPermission(roomId: string, requesterId: string, targetUserId: string, canControl: boolean): boolean;
    setPlayerPermission(roomId: string, requesterId: string, targetUserId: string): boolean;
    nextTrack(roomId: string, fromTrackId?: string): Track | null;
    voteSkip(roomId: string, userId: string): {
        skipped: boolean;
        votes: number;
        required: number;
    };
    heartTrack(roomId: string, trackId: string, userId: string): boolean;
    setTrackMessage(roomId: string, trackId: string, userId: string, message: string, voicePreset?: string): boolean;
}
