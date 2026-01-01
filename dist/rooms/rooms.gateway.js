"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoomsGateway = void 0;
const websockets_1 = require("@nestjs/websockets");
const socket_io_1 = require("socket.io");
const rooms_service_1 = require("./rooms.service");
let RoomsGateway = class RoomsGateway {
    roomsService;
    server;
    constructor(roomsService) {
        this.roomsService = roomsService;
        this.roomsService.setTrackEndCallback((roomId) => {
            console.log(`[Timer] Track ended automatically in room ${roomId}`);
            this.roomsService.nextTrack(roomId);
            this.broadcastRoomUpdate(roomId);
        });
        this.roomsService.setRoomClosedCallback((roomId) => {
            this.server.to(roomId).emit('error', { message: 'Phòng đã bị đóng do không hoạt động trong 1 giờ.' });
            this.server.to(roomId).emit('room:closed');
        });
    }
    handleConnection(client) {
        console.log(`Client connected: ${client.id}`);
    }
    handleDisconnect(client) {
        const result = this.roomsService.leaveRoom(client.id);
        if (result) {
            const { roomId, room } = result;
            if (room) {
                this.broadcastRoomUpdate(roomId);
            }
        }
        console.log(`[Socket] Client disconnected: ${client.id}`);
    }
    handleCreateRoom(data, client) {
        const room = this.roomsService.createRoom(data.name, client.id);
        client.join(room.roomId);
        const adjustedRoom = this.roomsService.getRoom(room.roomId);
        const user = room.users.find(u => u.socketId === client.id);
        client.emit('room:joined', { room: this.mapRoomForClient(adjustedRoom), user });
    }
    handleJoinRoom(data, client) {
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
        const adjustedRoom = this.roomsService.getRoom(room.roomId);
        client.emit('room:joined', { room: this.mapRoomForClient(adjustedRoom), user });
        this.broadcastRoomUpdate(room.roomId);
    }
    handleLeaveRoom(client) {
        const result = this.roomsService.leaveRoom(client.id);
        if (result) {
            const { roomId } = result;
            client.leave(roomId);
            this.broadcastRoomUpdate(roomId);
            client.emit('room:left');
            console.log(`Client ${client.id} manually left room ${roomId}`);
        }
    }
    async handleAddTrack(data, client) {
        const { track, error } = await this.roomsService.addTrack(data.roomId, data.youtubeUrl, data.userId, data.duration);
        if (track) {
            this.broadcastRoomUpdate(data.roomId);
        }
        else if (error === 'TRACK_LIMIT_REACHED') {
            client.emit('error', { message: 'Bạn không thể thêm quá 4 bài cùng lúc trong hàng đợi' });
        }
        else {
            client.emit('error', { message: 'Không thể thêm bài hát. Vui lòng thử lại.' });
        }
    }
    handleRemoveTrack(data, client) {
        const success = this.roomsService.removeTrack(data.roomId, data.trackId, data.userId);
        if (success) {
            this.broadcastRoomUpdate(data.roomId);
        }
        else {
            client.emit('error', { message: 'Unauthorized or track not found' });
        }
    }
    handleReorderQueue(data, client) {
        const success = this.roomsService.reorderQueue(data.roomId, data.userId, data.fromIndex, data.toIndex);
        if (success) {
            this.broadcastRoomUpdate(data.roomId);
        }
        else {
            client.emit('error', { message: 'Unauthorized or invalid indices' });
        }
    }
    handleTransferAdmin(data, client) {
        const success = this.roomsService.transferAdmin(data.roomId, data.currentAdminId, data.newAdminId);
        if (success) {
            this.broadcastRoomUpdate(data.roomId);
        }
        else {
            client.emit('error', { message: 'Failed to transfer admin rights' });
        }
    }
    handleSetControlPermission(data, client) {
        const success = this.roomsService.setControlPermission(data.roomId, data.requesterId, data.targetUserId, data.canControl);
        if (success) {
            this.broadcastRoomUpdate(data.roomId);
        }
        else {
            client.emit('error', { message: 'Failed to set control permission' });
        }
    }
    handleSetPlayerPermission(data, client) {
        const success = this.roomsService.setPlayerPermission(data.roomId, data.requesterId, data.targetUserId);
        if (success) {
            this.broadcastRoomUpdate(data.roomId);
        }
        else {
            client.emit('error', { message: 'Failed to set player permission' });
        }
    }
    handlePlaybackSync(data, client) {
        const success = this.roomsService.updatePlayback(data.roomId, data.userId, {
            isPlaying: data.isPlaying,
            currentTime: data.currentTime,
        });
        if (success) {
            this.broadcastRoomUpdate(data.roomId);
        }
    }
    handleTrackEnd(data) {
        this.roomsService.nextTrack(data.roomId);
        this.broadcastRoomUpdate(data.roomId);
    }
    handleHeartTrack(data, client) {
        const success = this.roomsService.heartTrack(data.roomId, data.trackId, data.userId);
        if (success) {
            this.broadcastRoomUpdate(data.roomId);
        }
        else {
            client.emit('error', { message: 'Failed to heart track' });
        }
    }
    broadcastRoomUpdate(roomId) {
        const room = this.roomsService.getRoom(roomId);
        if (room) {
            this.server.to(roomId).emit('room:update', this.mapRoomForClient(room));
        }
    }
    mapRoomForClient(room) {
        return {
            ...room,
            users: room.users.map(({ socketId, ...u }) => u),
        };
    }
};
exports.RoomsGateway = RoomsGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", socket_io_1.Server)
], RoomsGateway.prototype, "server", void 0);
__decorate([
    (0, websockets_1.SubscribeMessage)('room:create'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RoomsGateway.prototype, "handleCreateRoom", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('room:join'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RoomsGateway.prototype, "handleJoinRoom", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('room:leave'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RoomsGateway.prototype, "handleLeaveRoom", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('queue:add'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", Promise)
], RoomsGateway.prototype, "handleAddTrack", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('queue:remove'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RoomsGateway.prototype, "handleRemoveTrack", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('queue:reorder'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RoomsGateway.prototype, "handleReorderQueue", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('room:transfer-admin'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RoomsGateway.prototype, "handleTransferAdmin", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('permission:set-control'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RoomsGateway.prototype, "handleSetControlPermission", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('permission:set-player'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RoomsGateway.prototype, "handleSetPlayerPermission", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('playback:sync'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RoomsGateway.prototype, "handlePlaybackSync", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('track:end'),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], RoomsGateway.prototype, "handleTrackEnd", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('queue:heart'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RoomsGateway.prototype, "handleHeartTrack", null);
exports.RoomsGateway = RoomsGateway = __decorate([
    (0, websockets_1.WebSocketGateway)({
        cors: {
            origin: '*',
        },
        pingTimeout: 60000,
        pingInterval: 25000,
    }),
    __metadata("design:paramtypes", [rooms_service_1.RoomsService])
], RoomsGateway);
//# sourceMappingURL=rooms.gateway.js.map