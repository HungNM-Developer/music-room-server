import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomsService } from './rooms.service';
import { Track } from './types';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private readonly roomsService: RoomsService) {}

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    const result = this.roomsService.leaveRoom(client.id);
    if (result) {
      const { roomId, room } = result;
      if (room) {
        this.broadcastRoomUpdate(roomId);
      }
    }
    console.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('room:create')
  handleCreateRoom(
    @MessageBody() data: { name: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.roomsService.createRoom(data.name, client.id);
    client.join(room.roomId);
    
    // Use getRoom to get adjusted time state
    const adjustedRoom = this.roomsService.getRoom(room.roomId);
    const user = room.users.find(u => u.socketId === client.id);
    client.emit('room:joined', { room: this.mapRoomForClient(adjustedRoom), user });
  }

  @SubscribeMessage('room:join')
  handleJoinRoom(
    @MessageBody() data: { roomId: string; name: string },
    @ConnectedSocket() client: Socket,
  ) {
    const result = this.roomsService.joinRoom(data.roomId, data.name, client.id);
    if (!result) {
      client.emit('error', { message: 'Room not found' });
      return;
    }

    const { room, user } = result;
    client.join(room.roomId);
    
    // Use getRoom to get adjusted time state
    const adjustedRoom = this.roomsService.getRoom(room.roomId);
    client.emit('room:joined', { room: this.mapRoomForClient(adjustedRoom), user });
    this.broadcastRoomUpdate(room.roomId);
  }

  @SubscribeMessage('queue:add')
  async handleAddTrack(
    @MessageBody() data: { roomId: string; youtubeUrl: string; userId: string },
  ) {
    const track = await this.roomsService.addTrack(data.roomId, data.youtubeUrl, data.userId);
    if (track) {
      this.broadcastRoomUpdate(data.roomId);
    }
  }

  @SubscribeMessage('playback:sync')
  handlePlaybackSync(
    @MessageBody() data: { roomId: string; userId: string; isPlaying: boolean; currentTime: number },
    @ConnectedSocket() client: Socket,
  ) {
    const success = this.roomsService.updatePlayback(data.roomId, data.userId, {
      isPlaying: data.isPlaying,
      currentTime: data.currentTime,
    });

    if (success) {
      // Broadcast to all except sender to avoid feedback loops if necessary
      // But for simple MVP, broadcast update is fine
      this.broadcastRoomUpdate(data.roomId);
    }
  }

  @SubscribeMessage('track:end')
  handleTrackEnd(
    @MessageBody() data: { roomId: string },
  ) {
    this.roomsService.nextTrack(data.roomId);
    this.broadcastRoomUpdate(data.roomId);
  }

  private broadcastRoomUpdate(roomId: string) {
    const room = this.roomsService.getRoom(roomId);
    if (room) {
        this.server.to(roomId).emit('room:update', this.mapRoomForClient(room));
    }
  }

  private mapRoomForClient(room: any) {
    // Strips socket IDs for security/minimalism
    return {
      ...room,
      users: room.users.map(({ socketId, ...u }) => u),
    };
  }
}
