import { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomsService } from './rooms.service';
export declare class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
    private readonly roomsService;
    server: Server;
    constructor(roomsService: RoomsService);
    handleConnection(client: Socket): void;
    handleDisconnect(client: Socket): void;
    handleCreateRoom(data: {
        name: string;
    }, client: Socket): void;
    handleJoinRoom(data: {
        roomId: string;
        name: string;
    }, client: Socket): void;
    handleAddTrack(data: {
        roomId: string;
        youtubeUrl: string;
        userId: string;
    }): Promise<void>;
    handlePlaybackSync(data: {
        roomId: string;
        userId: string;
        isPlaying: boolean;
        currentTime: number;
    }, client: Socket): void;
    handleTrackEnd(data: {
        roomId: string;
    }): void;
    private broadcastRoomUpdate;
    private mapRoomForClient;
}
