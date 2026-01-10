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
    handleLeaveRoom(client: Socket): void;
    handleAddTrack(data: {
        roomId: string;
        youtubeUrl: string;
        userId: string;
        duration?: number;
    }, client: Socket): Promise<void>;
    handleSetTrackMessage(data: {
        roomId: string;
        trackId: string;
        userId: string;
        message: string;
        voicePreset?: string;
    }, client: Socket): void;
    handleRemoveTrack(data: {
        roomId: string;
        trackId: string;
        userId: string;
    }, client: Socket): void;
    handleReorderQueue(data: {
        roomId: string;
        userId: string;
        fromIndex: number;
        toIndex: number;
    }, client: Socket): void;
    handleTransferAdmin(data: {
        roomId: string;
        currentAdminId: string;
        newAdminId: string;
    }, client: Socket): void;
    handleSetControlPermission(data: {
        roomId: string;
        requesterId: string;
        targetUserId: string;
        canControl: boolean;
    }, client: Socket): void;
    handleSetPlayerPermission(data: {
        roomId: string;
        requesterId: string;
        targetUserId: string;
    }, client: Socket): void;
    handlePlaybackSync(data: {
        roomId: string;
        userId: string;
        isPlaying: boolean;
        currentTime: number;
    }, client: Socket): void;
    handleTrackEnd(data: {
        roomId: string;
        trackId?: string;
    }): void;
    handleVoteSkip(data: {
        roomId: string;
        userId: string;
    }, client: Socket): void;
    handleHeartTrack(data: {
        roomId: string;
        trackId: string;
        userId: string;
    }, client: Socket): void;
    handleReaction(data: {
        roomId: string;
        emoji: string;
    }, client: Socket): void;
    handleSoundEffect(data: {
        roomId: string;
        effect: string;
    }): void;
    handleChatSend(data: {
        roomId: string;
        content: string;
        userId: string;
        userName: string;
    }): void;
    private djCooldowns;
    private broadcastRoomUpdate;
    private mapRoomForClient;
    handleToggleDjPermission(data: {
        roomId: string;
        targetUserId: string;
        canDj: boolean;
        adminId: string;
    }, client: Socket): void;
    handleDjTrigger(data: {
        roomId: string;
        userId: string;
        soundType: string;
    }, client: Socket): void;
}
