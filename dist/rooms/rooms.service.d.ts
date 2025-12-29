import { Room, User, Track, PlaybackState } from './types';
export declare class RoomsService {
    private rooms;
    private colors;
    private getRandomColor;
    createRoom(adminName: string, socketId: string): Room;
    joinRoom(roomId: string, name: string, socketId: string): {
        room: Room;
        user: User;
    } | null;
    leaveRoom(socketId: string): {
        roomId: string;
        room: Room;
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
    nextTrack(roomId: string): Track | null;
}
