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
import { Track, ActivityLog, ChatMessage } from './types';
import { v4 as uuidv4 } from 'uuid';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private readonly roomsService: RoomsService) {
    console.log('[RoomsGateway] Chat Feature & Activity Log Ready!');
    this.roomsService.setTrackEndCallback((roomId) => {
      console.log(`[Event] Track transition confirmed for room ${roomId}`);
      // nextTrack was already called inside Service.triggerTrackEnd.
      // Calling it again here was the source of the double-skip bug.
      this.broadcastRoomUpdate(roomId);
    });

    this.roomsService.setRoomClosedCallback((roomId) => {
      this.server.to(roomId).emit('error', { message: 'Phòng đã bị đóng do không hoạt động trong 1 giờ.' });
      this.server.to(roomId).emit('room:closed');
    });

    this.roomsService.setActivityLogCallback((roomId, log) => {
      console.log(`[Gateway] EMITTING activity:new to ${roomId} - LogID: ${log.id}`);
      this.server.to(roomId).emit('activity:new', log);
    });
  }

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
    console.log(`[Socket] Client disconnected: ${client.id}`);
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

    if (result.error === 'NAME_TAKEN') {
      client.emit('error', { message: 'Tên này đã có người sử dụng trong phòng' });
      return;
    }

    const { room, user } = result;
    client.join(room.roomId);

    // Use getRoom to get adjusted time state
    const adjustedRoom = this.roomsService.getRoom(room.roomId);
    client.emit('room:joined', { room: this.mapRoomForClient(adjustedRoom), user });
    this.broadcastRoomUpdate(room.roomId);
  }

  @SubscribeMessage('room:leave')
  handleLeaveRoom(@ConnectedSocket() client: Socket) {
    const result = this.roomsService.leaveRoom(client.id);
    if (result) {
      const { roomId } = result;
      client.leave(roomId);
      this.broadcastRoomUpdate(roomId);
      client.emit('room:left');
      console.log(`Client ${client.id} manually left room ${roomId}`);
    }
  }

  @SubscribeMessage('queue:add')
  async handleAddTrack(
    @MessageBody() data: { roomId: string; youtubeUrl: string; userId: string; duration?: number },
    @ConnectedSocket() client: Socket,
  ) {
    const { track, error } = await this.roomsService.addTrack(
      data.roomId,
      data.youtubeUrl,
      data.userId,
      data.duration
    );

    if (track) {
      this.broadcastRoomUpdate(data.roomId);
    } else if (error === 'TRACK_LIMIT_REACHED') {
      client.emit('error', { message: 'Bạn không thể thêm quá 4 bài cùng lúc trong hàng đợi' });
    } else {
      client.emit('error', { message: 'Không thể thêm bài hát. Vui lòng thử lại.' });
    }
  }

  @SubscribeMessage('queue:set-message')
  handleSetTrackMessage(
    @MessageBody() data: { roomId: string; trackId: string; userId: string; message: string; voicePreset?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const success = this.roomsService.setTrackMessage(
      data.roomId,
      data.trackId,
      data.userId,
      data.message,
      data.voicePreset
    );
    if (success) {
      this.broadcastRoomUpdate(data.roomId);
    } else {
      client.emit('error', { message: 'Không thể gửi lời chúc. Có lỗi xảy ra.' });
    }
  }


  @SubscribeMessage('queue:remove')

  handleRemoveTrack(
    @MessageBody() data: { roomId: string; trackId: string; userId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const success = this.roomsService.removeTrack(data.roomId, data.trackId, data.userId);
    if (success) {
      this.broadcastRoomUpdate(data.roomId);
    } else {
      client.emit('error', { message: 'Unauthorized or track not found' });
    }
  }

  @SubscribeMessage('queue:reorder')
  handleReorderQueue(
    @MessageBody() data: { roomId: string; userId: string; fromIndex: number; toIndex: number },
    @ConnectedSocket() client: Socket,
  ) {
    const success = this.roomsService.reorderQueue(
      data.roomId,
      data.userId,
      data.fromIndex,
      data.toIndex,
    );

    if (success) {
      this.broadcastRoomUpdate(data.roomId);
    } else {
      client.emit('error', { message: 'Unauthorized or invalid indices' });
    }
  }

  @SubscribeMessage('room:transfer-admin')
  handleTransferAdmin(
    @MessageBody() data: { roomId: string; currentAdminId: string; newAdminId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const success = this.roomsService.transferAdmin(
      data.roomId,
      data.currentAdminId,
      data.newAdminId,
    );

    if (success) {
      this.broadcastRoomUpdate(data.roomId);
    } else {
      client.emit('error', { message: 'Failed to transfer admin rights' });
    }
  }

  @SubscribeMessage('permission:set-control')
  handleSetControlPermission(
    @MessageBody() data: { roomId: string; requesterId: string; targetUserId: string; canControl: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    const success = this.roomsService.setControlPermission(
      data.roomId,
      data.requesterId,
      data.targetUserId,
      data.canControl,
    );

    if (success) {
      this.broadcastRoomUpdate(data.roomId);
    } else {
      client.emit('error', { message: 'Failed to set control permission' });
    }
  }

  @SubscribeMessage('permission:set-player')
  handleSetPlayerPermission(
    @MessageBody() data: { roomId: string; requesterId: string; targetUserId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const success = this.roomsService.setPlayerPermission(
      data.roomId,
      data.requesterId,
      data.targetUserId,
    );

    if (success) {
      this.broadcastRoomUpdate(data.roomId);
    } else {
      client.emit('error', { message: 'Failed to set player permission' });
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
    @MessageBody() data: { roomId: string; trackId?: string },
  ) {
    this.roomsService.nextTrack(data.roomId, data.trackId);
    this.broadcastRoomUpdate(data.roomId);
  }

  @SubscribeMessage('queue:vote-skip')
  handleVoteSkip(
    @MessageBody() data: { roomId: string; userId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const result = this.roomsService.voteSkip(data.roomId, data.userId);
    if (result.skipped || result.votes > 0) {
      this.broadcastRoomUpdate(data.roomId);
    } else {
      client.emit('error', { message: 'Vote skip failed' });
    }
  }

  @SubscribeMessage('queue:heart')
  handleHeartTrack(
    @MessageBody() data: { roomId: string; trackId: string; userId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const success = this.roomsService.heartTrack(data.roomId, data.trackId, data.userId);
    if (success) {
      this.broadcastRoomUpdate(data.roomId);
    } else {
      client.emit('error', { message: 'Failed to heart track' });
    }
  }

  @SubscribeMessage('room:reaction')
  handleReaction(
    @MessageBody() data: { roomId: string; emoji: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.server.to(data.roomId).emit('room:reaction', { emoji: data.emoji, id: Math.random() });

    // Log reaction
    const room = this.roomsService.getRoom(data.roomId);
    if (room) {
      const user = room.users.find(u => u.socketId === client.id);
      console.log(`[Reaction Debug] Room: ${data.roomId}, Client: ${client.id}, UserFound: ${!!user}`);
      if (user) {
        this.roomsService.logActivity(data.roomId, 'reaction', user.userId, user.name, `reacted with ${data.emoji}`);
      } else {
        console.log(`[Reaction Debug] User not found in room users list:`, room.users.map(u => u.socketId));
      }
    } else {
      console.log(`[Reaction Debug] Room not found: ${data.roomId}`);
    }
  }

  @SubscribeMessage('room:sound-effect')
  handleSoundEffect(
    @MessageBody() data: { roomId: string; effect: string },
  ) {
    this.server.to(data.roomId).emit('room:sound-effect', { effect: data.effect });
  }

  @SubscribeMessage('chat:send')
  handleChatSend(
    @MessageBody() data: { roomId: string; content: string; userId: string; userName: string },
  ) {
    const message: ChatMessage = {
      id: uuidv4(),
      userId: data.userId,
      userName: data.userName,
      content: data.content,
      timestamp: Date.now(),
    };
    this.server.to(data.roomId).emit('chat:receive', message);
  }

  private djCooldowns = new Map<string, number>();

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

  @SubscribeMessage('dj:toggle-permission')
  handleToggleDjPermission(
    @MessageBody() data: { roomId: string; targetUserId: string; canDj: boolean; adminId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.roomsService.getRoom(data.roomId);
    if (!room || room.adminId !== data.adminId) {
      client.emit('error', { message: 'Chỉ Admin mới có quyền cấp phép DJ.' });
      return;
    }

    const success = this.roomsService.setDjPermission(data.roomId, data.targetUserId, data.canDj);
    if (success) {
      this.broadcastRoomUpdate(data.roomId);
    }
  }

  @SubscribeMessage('dj:trigger')
  handleDjTrigger(
    @MessageBody() data: { roomId: string; userId: string; soundType: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.roomsService.getRoom(data.roomId);
    if (!room) return;

    const user = room.users.find(u => u.userId === data.userId);
    if (!user || (!user.canDj && room.adminId !== user.userId)) {
      client.emit('error', { message: 'Bạn không có quyền DJ.' });
      return;
    }

    // Cooldown check (1.5 seconds per user)
    const cooldownKey = `${data.roomId}:${data.userId}`;
    const now = Date.now();
    const lastTrigger = this.djCooldowns.get(cooldownKey) || 0;
    if (now - lastTrigger < 1500) {
      return; // Silently ignore anti-spam
    }

    this.djCooldowns.set(cooldownKey, now);
    this.server.to(data.roomId).emit('dj:event', { 
      userId: data.userId, 
      userName: user.name, 
      soundType: data.soundType 
    });
  }
}

