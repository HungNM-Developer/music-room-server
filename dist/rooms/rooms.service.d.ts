import { Room, User, Track, PlaybackState } from './types';
export declare class RoomsService {
    private rooms;
    private colors;
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
    addTrack(roomId: string, youtubeUrl: string, userId: string): Promise<Track | null>;
    removeTrack(roomId: string, trackId: string, userId: string): boolean;
    updatePlayback(roomId: string, userId: string, state: Partial<PlaybackState>): boolean;
    reorderQueue(roomId: string, userId: string, fromIndex: number, toIndex: number): boolean;
    transferAdmin(roomId: string, currentAdminId: string, newAdminId: string): boolean;
    nextTrack(roomId: string): Track | null;
}
