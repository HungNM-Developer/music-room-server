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
        console.log(`Client disconnected: ${client.id}`);
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
        const { room, user } = result;
        client.join(room.roomId);
        const adjustedRoom = this.roomsService.getRoom(room.roomId);
        client.emit('room:joined', { room: this.mapRoomForClient(adjustedRoom), user });
        this.broadcastRoomUpdate(room.roomId);
    }
    async handleAddTrack(data) {
        const track = await this.roomsService.addTrack(data.roomId, data.youtubeUrl, data.userId);
        if (track) {
            this.broadcastRoomUpdate(data.roomId);
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
    (0, websockets_1.SubscribeMessage)('queue:add'),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], RoomsGateway.prototype, "handleAddTrack", null);
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
exports.RoomsGateway = RoomsGateway = __decorate([
    (0, websockets_1.WebSocketGateway)({
        cors: {
            origin: '*',
        },
    }),
    __metadata("design:paramtypes", [rooms_service_1.RoomsService])
], RoomsGateway);
//# sourceMappingURL=rooms.gateway.js.map