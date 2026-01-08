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
    inactivityTimers = new Map();
    trackEndTimers = new Map();
    onTrackEndCallback;
    onRoomClosedCallback;
    onActivityLogCallback;
    COLORS = [
        '#FF5733', '#33FF57', '#3357FF', '#F333FF', '#33FFF3',
        '#FFC300', '#DAF7A6', '#C70039', '#900C3F', '#581845'
    ];
    setTrackEndCallback(callback) {
        this.onTrackEndCallback = callback;
    }
    setRoomClosedCallback(callback) {
        this.onRoomClosedCallback = callback;
    }
    setActivityLogCallback(callback) {
        this.onActivityLogCallback = callback;
    }
    logActivity(roomId, type, userId, userName, message, metadata) {
        const room = this.rooms.get(roomId);
        if (!room)
            return;
        const log = {
            id: (0, uuid_1.v4)(),
            timestamp: Date.now(),
            type,
            userId,
            userName,
            message,
            metadata
        };
        if (!room.activityLogs) {
            room.activityLogs = [];
        }
        room.activityLogs.unshift(log);
        if (room.activityLogs.length > 50) {
            room.activityLogs = room.activityLogs.slice(0, 50);
        }
        if (this.onActivityLogCallback) {
            console.log(`[Service Debug] logActivity calling callback for room ${roomId}`);
            this.onActivityLogCallback(roomId, log);
        }
        else {
            console.log(`[Service Debug] logActivity NO callback set for room ${roomId}`);
        }
    }
    resetInactivityTimer(roomId) {
        this.stopInactivityTimer(roomId);
        const timer = setTimeout(() => {
            console.log(`[Auto-Close] Room ${roomId} closed due to 1 hour of inactivity.`);
            this.closeRoom(roomId);
        }, 3600000);
        this.inactivityTimers.set(roomId, timer);
    }
    stopInactivityTimer(roomId) {
        const timer = this.inactivityTimers.get(roomId);
        if (timer) {
            clearTimeout(timer);
            this.inactivityTimers.delete(roomId);
        }
    }
    closeRoom(roomId) {
        this.clearTrackTimer(roomId);
        this.stopInactivityTimer(roomId);
        this.rooms.delete(roomId);
        if (this.onRoomClosedCallback) {
            this.onRoomClosedCallback(roomId);
        }
    }
    clearTrackTimer(roomId) {
        const timer = this.trackEndTimers.get(roomId);
        if (timer) {
            clearTimeout(timer);
            this.trackEndTimers.delete(roomId);
        }
    }
    scheduleTrackEnd(roomId) {
        this.clearTrackTimer(roomId);
        const room = this.rooms.get(roomId);
        if (!room || !room.currentTrack || !room.playbackState.isPlaying)
            return;
        if (!room.currentTrack.duration || room.currentTrack.duration <= 0)
            return;
        const currentTrackId = room.currentTrack.trackId;
        const remainingSeconds = (room.currentTrack.duration || 0) - room.playbackState.currentTime;
        if (remainingSeconds <= 0) {
            this.triggerTrackEnd(roomId, currentTrackId);
            return;
        }
        const timer = setTimeout(() => {
            this.triggerTrackEnd(roomId, currentTrackId);
        }, Math.max(0, remainingSeconds * 1000));
        this.trackEndTimers.set(roomId, timer);
    }
    triggerTrackEnd(roomId, expectedTrackId) {
        this.nextTrack(roomId, expectedTrackId);
        if (this.onTrackEndCallback) {
            this.onTrackEndCallback(roomId);
        }
    }
    getRandomColor() {
        return this.COLORS[Math.floor(Math.random() * this.COLORS.length)];
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
            canPlay: true,
            canControl: true,
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
            skipVotes: [],
            activityLogs: [],
        };
        this.rooms.set(roomId, room);
        this.resetInactivityTimer(roomId);
        this.logActivity(roomId, 'user_join', adminId, adminName, 'created the room');
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
            canPlay: false,
            canControl: false,
        };
        room.users.push(user);
        this.resetInactivityTimer(roomId);
        this.logActivity(roomId, 'user_join', user.userId, user.name, 'joined the room');
        return { room, user };
    }
    leaveRoom(socketId) {
        for (const [roomId, room] of this.rooms.entries()) {
            const userIndex = room.users.findIndex((u) => u.socketId === socketId);
            if (userIndex !== -1) {
                const [user] = room.users.splice(userIndex, 1);
                this.logActivity(roomId, 'user_leave', user.userId, user.name, 'left the room');
                room.queue.forEach(track => {
                    track.hearts = track.hearts.filter(id => id !== user.userId);
                });
                if (room.currentTrack) {
                    room.currentTrack.hearts = room.currentTrack.hearts.filter(id => id !== user.userId);
                }
                room.skipVotes = room.skipVotes.filter(id => id !== user.userId);
                room.queue.sort((a, b) => {
                    if (b.hearts.length !== a.hearts.length) {
                        return b.hearts.length - a.hearts.length;
                    }
                    return a.addedAt - b.addedAt;
                });
                if (room.users.length === 0) {
                    this.clearTrackTimer(roomId);
                    this.rooms.delete(roomId);
                    return { roomId, room: null };
                }
                if (user.role === 'admin') {
                    room.users[0].role = 'admin';
                    room.adminId = room.users[0].userId;
                }
                if (room.currentTrack) {
                    const activeVotes = room.skipVotes.filter(uid => room.users.some(u => u.userId === uid)).length;
                    const requiredVotes = Math.floor(room.users.length / 2) + 1;
                    if (activeVotes >= requiredVotes) {
                        this.nextTrack(roomId, room.currentTrack.trackId);
                    }
                }
                this.resetInactivityTimer(roomId);
                return { roomId, room };
            }
        }
        return null;
    }
    getRoom(roomId) {
        const room = this.rooms.get(roomId);
        if (!room)
            return null;
        return this.getAdjustedRoom(room);
    }
    getAdjustedRoom(room) {
        if (!room.currentTrack || !room.playbackState.isPlaying) {
            return room;
        }
        const now = Date.now();
        const elapsed = (now - room.playbackState.lastUpdated) / 1000;
        const calculatedTime = room.playbackState.currentTime + elapsed;
        if (calculatedTime >= (room.currentTrack.duration || Infinity)) {
            return {
                ...room,
                playbackState: { ...room.playbackState, currentTime: room.currentTrack.duration }
            };
        }
        return {
            ...room,
            playbackState: {
                ...room.playbackState,
                currentTime: calculatedTime,
                lastUpdated: now
            }
        };
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
    async addTrack(roomId, youtubeUrl, userId, duration, message) {
        const room = this.rooms.get(roomId);
        if (!room)
            return { track: null, error: 'ROOM_NOT_FOUND' };
        const user = room.users.find(u => u.userId === userId);
        const userName = user ? user.name : 'Unknown User';
        const userTrackCount = room.queue.filter(t => t.addedBy === userId).length;
        if (userTrackCount >= 4) {
            return { track: null, error: 'TRACK_LIMIT_REACHED' };
        }
        const metadata = await this.fetchYoutubeMetadata(youtubeUrl);
        const newTrack = {
            trackId: (0, uuid_1.v4)(),
            youtubeUrl,
            addedBy: userId,
            ...metadata,
            duration: duration || metadata.duration || 0,
            hearts: [],
            addedAt: Date.now(),
            message,
        };
        if (!room.currentTrack) {
            room.currentTrack = newTrack;
            room.playbackState.isPlaying = true;
            room.playbackState.lastUpdated = Date.now();
            room.playbackState.currentTime = 0;
            this.stopInactivityTimer(roomId);
            this.scheduleTrackEnd(roomId);
        }
        else {
            room.queue.push(newTrack);
            this.resetInactivityTimer(roomId);
        }
        this.logActivity(roomId, 'track_add', userId, userName, `added "${newTrack.title}"`);
        return { track: newTrack };
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
            this.resetInactivityTimer(roomId);
            this.logActivity(roomId, 'track_remove', userId, user.name, `removed "${track.title}" from queue`);
            return true;
        }
        return false;
    }
    updatePlayback(roomId, userId, state) {
        const room = this.rooms.get(roomId);
        if (!room)
            return false;
        const user = room.users.find(u => u.userId === userId);
        if (!user || (!user.canPlay && user.role !== 'admin'))
            return false;
        room.playbackState = {
            ...room.playbackState,
            ...state,
            lastUpdated: Date.now(),
        };
        if (room.playbackState.isPlaying) {
            this.stopInactivityTimer(roomId);
            this.scheduleTrackEnd(roomId);
        }
        else {
            this.clearTrackTimer(roomId);
            this.resetInactivityTimer(roomId);
        }
        return true;
    }
    reorderQueue(roomId, userId, fromIndex, toIndex) {
        const room = this.rooms.get(roomId);
        if (!room)
            return false;
        const user = room.users.find((u) => u.userId === userId);
        if (!user || (!user.canControl && user.role !== 'admin'))
            return false;
        if (fromIndex < 0 || fromIndex >= room.queue.length ||
            toIndex < 0 || toIndex >= room.queue.length) {
            return false;
        }
        const [movedTrack] = room.queue.splice(fromIndex, 1);
        room.queue.splice(toIndex, 0, movedTrack);
        this.logActivity(roomId, 'queue_reorder', userId, user.name, 'reordered the queue');
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
        targetUser.canControl = true;
        this.logActivity(roomId, 'admin_transfer', currentAdminId, currentAdmin.name, `promoted ${targetUser.name} to admin`);
        return true;
    }
    setControlPermission(roomId, requesterId, targetUserId, canControl) {
        const room = this.rooms.get(roomId);
        if (!room || room.adminId !== requesterId)
            return false;
        const targetUser = room.users.find(u => u.userId === targetUserId);
        if (!targetUser)
            return false;
        targetUser.canControl = canControl;
        const requester = room.users.find(u => u.userId === requesterId);
        if (requester) {
            this.logActivity(roomId, 'permission_change', requesterId, requester.name, `${canControl ? 'granted' : 'revoked'} control for ${targetUser.name}`);
        }
        return true;
    }
    setPlayerPermission(roomId, requesterId, targetUserId) {
        const room = this.rooms.get(roomId);
        if (!room || room.adminId !== requesterId)
            return false;
        room.users.forEach(u => u.canPlay = false);
        const targetUser = room.users.find(u => u.userId === targetUserId);
        if (!targetUser)
            return false;
        targetUser.canPlay = true;
        const requester = room.users.find(u => u.userId === requesterId);
        if (requester) {
            this.logActivity(roomId, 'permission_change', requesterId, requester.name, `set ${targetUser.name} as DJ`);
        }
        return true;
    }
    nextTrack(roomId, fromTrackId) {
        const room = this.rooms.get(roomId);
        if (!room)
            return null;
        if (fromTrackId && room.currentTrack && room.currentTrack.trackId !== fromTrackId) {
            return room.currentTrack;
        }
        if (room.queue.length > 0) {
            room.currentTrack = room.queue.shift() || null;
            room.playbackState.currentTime = 0;
            room.playbackState.lastUpdated = Date.now();
            room.playbackState.isPlaying = true;
            this.stopInactivityTimer(roomId);
            this.scheduleTrackEnd(roomId);
        }
        else {
            room.currentTrack = null;
            room.playbackState.isPlaying = false;
            this.clearTrackTimer(roomId);
            this.resetInactivityTimer(roomId);
        }
        room.skipVotes = [];
        return room.currentTrack;
    }
    voteSkip(roomId, userId) {
        const room = this.rooms.get(roomId);
        if (!room || !room.currentTrack)
            return { skipped: false, votes: 0, required: 0 };
        if (!room.skipVotes.includes(userId)) {
            room.skipVotes.push(userId);
        }
        const activeVotes = room.skipVotes.filter(uid => room.users.some(u => u.userId === uid)).length;
        const totalUsers = room.users.length;
        const requiredVotes = Math.floor(totalUsers / 2) + 1;
        if (activeVotes >= requiredVotes) {
            const user = room.users.find(u => u.userId === userId);
            if (user) {
                this.logActivity(roomId, 'track_skip', userId, user.name, 'voted to skip track');
            }
            this.nextTrack(roomId, room.currentTrack.trackId);
            return { skipped: true, votes: activeVotes, required: requiredVotes };
        }
        return { skipped: false, votes: activeVotes, required: requiredVotes };
    }
    heartTrack(roomId, trackId, userId) {
        const room = this.rooms.get(roomId);
        if (!room)
            return false;
        room.queue.forEach((track) => {
            const index = track.hearts.indexOf(userId);
            if (index !== -1) {
                track.hearts.splice(index, 1);
            }
        });
        const targetTrack = room.queue.find((t) => t.trackId === trackId);
        if (targetTrack) {
            targetTrack.hearts.push(userId);
        }
        else {
            return false;
        }
        room.queue.sort((a, b) => {
            if (b.hearts.length !== a.hearts.length) {
                return b.hearts.length - a.hearts.length;
            }
            return a.addedAt - b.addedAt;
        });
        const user = room.users.find(u => u.userId === userId);
        if (user && targetTrack) {
            this.logActivity(roomId, 'track_heart', userId, user.name, `loved "${targetTrack.title}"`);
        }
        return true;
    }
};
exports.RoomsService = RoomsService;
exports.RoomsService = RoomsService = __decorate([
    (0, common_1.Injectable)()
], RoomsService);
//# sourceMappingURL=rooms.service.js.map