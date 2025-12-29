"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoomsService = void 0;
const common_1 = require("@nestjs/common");
const uuid_1 = require("uuid");
const axios_1 = __importDefault(require("axios"));
let RoomsService = class RoomsService {
    rooms = new Map();
    colors = [
        '#FF5733', '#33FF57', '#3357FF', '#F333FF', '#33FFF3',
        '#FFC300', '#DAF7A6', '#C70039', '#900C3F', '#581845'
    ];
    getRandomColor() {
        return this.colors[Math.floor(Math.random() * this.colors.length)];
    }
    createRoom(adminName, socketId) {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const adminId = (0, uuid_1.v4)();
        const admin = {
            userId: adminId,
            socketId,
            name: adminName,
            role: 'admin',
            color: this.getRandomColor(),
        };
        const room = {
            roomId,
            adminId,
            users: [admin],
            queue: [],
            currentTrack: null,
            playbackState: {
                isPlaying: false,
                currentTime: 0,
                lastUpdated: Date.now(),
            },
        };
        this.rooms.set(roomId, room);
        return room;
    }
    joinRoom(roomId, name, socketId) {
        const room = this.rooms.get(roomId);
        if (!room)
            return null;
        const nameExists = room.users.some((u) => u.name.toLowerCase() === name.toLowerCase());
        if (nameExists) {
            return { room: null, user: null, error: 'NAME_TAKEN' };
        }
        const user = {
            userId: (0, uuid_1.v4)(),
            socketId,
            name,
            role: 'user',
            color: this.getRandomColor(),
        };
        room.users.push(user);
        return { room, user };
    }
    leaveRoom(socketId) {
        for (const [roomId, room] of this.rooms.entries()) {
            const userIndex = room.users.findIndex((u) => u.socketId === socketId);
            if (userIndex !== -1) {
                const [user] = room.users.splice(userIndex, 1);
                if (room.users.length === 0) {
                    this.rooms.delete(roomId);
                    return { roomId, room: null };
                }
                if (user.role === 'admin') {
                    room.users[0].role = 'admin';
                    room.adminId = room.users[0].userId;
                }
                return { roomId, room };
            }
        }
        return null;
    }
    getRoom(roomId) {
        const room = this.rooms.get(roomId);
        if (!room)
            return undefined;
        const adjustedRoom = { ...room };
        if (room.playbackState.isPlaying) {
            const elapsed = (Date.now() - room.playbackState.lastUpdated) / 1000;
            adjustedRoom.playbackState = {
                ...room.playbackState,
                currentTime: room.playbackState.currentTime + elapsed,
            };
        }
        return adjustedRoom;
    }
    async fetchYoutubeMetadata(url) {
        try {
            const response = await axios_1.default.get(`https://www.youtube.com/oembed?url=${url}&format=json`);
            const { title, thumbnail_url } = response.data;
            return {
                title: title || 'Unknown Title',
                thumbnail: thumbnail_url || '',
                duration: 0
            };
        }
        catch (e) {
            const videoId = url.split('v=')[1]?.split('&')[0];
            return {
                title: videoId ? `Video ${videoId}` : 'Invalid URL',
                thumbnail: videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : '',
                duration: 0
            };
        }
    }
    async addTrack(roomId, youtubeUrl, userId) {
        const room = this.rooms.get(roomId);
        if (!room)
            return null;
        const metadata = await this.fetchYoutubeMetadata(youtubeUrl);
        const newTrack = {
            trackId: (0, uuid_1.v4)(),
            youtubeUrl,
            addedBy: userId,
            ...metadata,
        };
        if (!room.currentTrack) {
            room.currentTrack = newTrack;
            room.playbackState.isPlaying = true;
            room.playbackState.lastUpdated = Date.now();
            room.playbackState.currentTime = 0;
        }
        else {
            room.queue.push(newTrack);
        }
        return newTrack;
    }
    removeTrack(roomId, trackId, userId) {
        const room = this.rooms.get(roomId);
        if (!room)
            return false;
        const user = room.users.find((u) => u.userId === userId);
        if (!user)
            return false;
        const trackIndex = room.queue.findIndex((t) => t.trackId === trackId);
        if (trackIndex === -1)
            return false;
        const track = room.queue[trackIndex];
        if (user.role === 'admin' || track.addedBy === userId) {
            room.queue.splice(trackIndex, 1);
            return true;
        }
        return false;
    }
    updatePlayback(roomId, userId, state) {
        const room = this.rooms.get(roomId);
        if (!room)
            return false;
        const user = room.users.find(u => u.userId === userId);
        if (!user || user.role !== 'admin')
            return false;
        room.playbackState = {
            ...room.playbackState,
            ...state,
            lastUpdated: Date.now(),
        };
        return true;
    }
    reorderQueue(roomId, userId, fromIndex, toIndex) {
        const room = this.rooms.get(roomId);
        if (!room)
            return false;
        const user = room.users.find((u) => u.userId === userId);
        if (!user || user.role !== 'admin')
            return false;
        if (fromIndex < 0 || fromIndex >= room.queue.length ||
            toIndex < 0 || toIndex >= room.queue.length) {
            return false;
        }
        const [movedTrack] = room.queue.splice(fromIndex, 1);
        room.queue.splice(toIndex, 0, movedTrack);
        return true;
    }
    transferAdmin(roomId, currentAdminId, newAdminId) {
        const room = this.rooms.get(roomId);
        if (!room)
            return false;
        if (room.adminId !== currentAdminId)
            return false;
        const currentAdmin = room.users.find((u) => u.userId === currentAdminId);
        const targetUser = room.users.find((u) => u.userId === newAdminId);
        if (!currentAdmin || !targetUser)
            return false;
        currentAdmin.role = 'user';
        targetUser.role = 'admin';
        room.adminId = newAdminId;
        return true;
    }
    nextTrack(roomId) {
        const room = this.rooms.get(roomId);
        if (!room)
            return null;
        if (room.queue.length > 0) {
            room.currentTrack = room.queue.shift() || null;
            room.playbackState.currentTime = 0;
            room.playbackState.lastUpdated = Date.now();
            room.playbackState.isPlaying = true;
        }
        else {
            room.currentTrack = null;
            room.playbackState.isPlaying = false;
        }
        return room.currentTrack;
    }
};
exports.RoomsService = RoomsService;
exports.RoomsService = RoomsService = __decorate([
    (0, common_1.Injectable)()
], RoomsService);
//# sourceMappingURL=rooms.service.js.map