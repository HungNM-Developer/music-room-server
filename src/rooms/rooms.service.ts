import { Injectable } from '@nestjs/common';
import { Room, User, Track, PlaybackState } from './types';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

@Injectable()
export class RoomsService {
  private rooms: Map<string, Room> = new Map();
  private inactivityTimers: Map<string, NodeJS.Timeout> = new Map();
  private trackEndTimers: Map<string, NodeJS.Timeout> = new Map();
  private onTrackEndCallback: (roomId: string) => void;
  private onRoomClosedCallback: (roomId: string) => void;

  private COLORS = [
    '#FF5733', '#33FF57', '#3357FF', '#F333FF', '#33FFF3', 
    '#FFC300', '#DAF7A6', '#C70039', '#900C3F', '#581845'
  ];

  setTrackEndCallback(callback: (roomId: string) => void) {
    this.onTrackEndCallback = callback;
  }

  setRoomClosedCallback(callback: (roomId: string) => void) {
    this.onRoomClosedCallback = callback;
  }

  private resetInactivityTimer(roomId: string) {
    this.stopInactivityTimer(roomId);
    
    // Set timer for 1 hour (3600000 ms)
    const timer = setTimeout(() => {
      console.log(`[Auto-Close] Room ${roomId} closed due to 1 hour of inactivity.`);
      this.closeRoom(roomId);
    }, 3600000); 

    this.inactivityTimers.set(roomId, timer);
  }

  private stopInactivityTimer(roomId: string) {
    const timer = this.inactivityTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.inactivityTimers.delete(roomId);
    }
  }

  private closeRoom(roomId: string) {
    this.clearTrackTimer(roomId);
    this.stopInactivityTimer(roomId);
    this.rooms.delete(roomId);
    if (this.onRoomClosedCallback) {
      this.onRoomClosedCallback(roomId);
    }
  }

  private clearTrackTimer(roomId: string) {
    const timer = this.trackEndTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.trackEndTimers.delete(roomId);
    }
  }

  private scheduleTrackEnd(roomId: string) {
    this.clearTrackTimer(roomId);
    const room = this.rooms.get(roomId);
    if (!room || !room.currentTrack || !room.playbackState.isPlaying) return;

    const remainingSeconds = (room.currentTrack.duration || 0) - room.playbackState.currentTime;
    if (remainingSeconds <= 0 && room.currentTrack.duration > 0) {
      this.triggerTrackEnd(roomId);
      return;
    }

    // Set a one-shot timer for the exact end of the track
    const timer = setTimeout(() => {
      this.triggerTrackEnd(roomId);
    }, Math.max(0, remainingSeconds * 1000));

    this.trackEndTimers.set(roomId, timer);
  }

  private triggerTrackEnd(roomId: string) {
    this.nextTrack(roomId);
    if (this.onTrackEndCallback) {
      this.onTrackEndCallback(roomId);
    }
  }

  private getRandomColor() {
    return this.COLORS[Math.floor(Math.random() * this.COLORS.length)];
  }

  createRoom(adminName: string, socketId: string): Room {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const adminId = uuidv4();
    
    const admin: User = {
      userId: adminId,
      socketId,
      name: adminName,
      role: 'admin',
      color: this.getRandomColor(),
      canPlay: true,    // Admin is the default player
      canControl: true, // Admin can control everything
    };

    const room: Room = {
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
    this.resetInactivityTimer(roomId);
    return room;
  }

  joinRoom(roomId: string, name: string, socketId: string): { room: Room; user: User; error?: string } | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    // Check if name already exists in this room
    const nameExists = room.users.some(
      (u) => u.name.toLowerCase() === name.toLowerCase(),
    );
    if (nameExists) {
      return { room: null as any, user: null as any, error: 'NAME_TAKEN' };
    }

    const user: User = {
      userId: uuidv4(),
      socketId,
      name,
      role: 'user',
      color: this.getRandomColor(),
      canPlay: false,    // Default user cannot play
      canControl: false, // Default user cannot control
    };

    room.users.push(user);
    this.resetInactivityTimer(roomId);
    return { room, user };
  }

  leaveRoom(socketId: string): { roomId: string; room: Room | null } | null {
    for (const [roomId, room] of this.rooms.entries()) {
      const userIndex = room.users.findIndex((u) => u.socketId === socketId);
      if (userIndex !== -1) {
        const [user] = room.users.splice(userIndex, 1);
        
        // Scenario 1: Room becomes empty
        if (room.users.length === 0) {
          this.clearTrackTimer(roomId);
          this.rooms.delete(roomId);
          return { roomId, room: null }; // Room is gone
        }

        // Scenario 2: Admin leaves but others are still there
        if (user.role === 'admin') {
          room.users[0].role = 'admin';
          room.adminId = room.users[0].userId;
        }
        
        this.resetInactivityTimer(roomId);
        return { roomId, room };
      }
    }
    return null;
  }

  getRoom(roomId: string): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return this.getAdjustedRoom(room);
  }

  // Calculate high-precision time without intervals
  private getAdjustedRoom(room: Room): Room {
    if (!room.currentTrack || !room.playbackState.isPlaying) {
      return room;
    }

    const now = Date.now();
    const elapsed = (now - room.playbackState.lastUpdated) / 1000;
    const calculatedTime = room.playbackState.currentTime + elapsed;

    // If track ended naturally
    if (calculatedTime >= (room.currentTrack.duration || Infinity)) {
      // We don't call nextTrack here to avoid side effects during a "get"
      // But we cap the time
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

  async fetchYoutubeMetadata(url: string): Promise<{ title: string; thumbnail: string; duration: number }> {
    try {
      const response = await axios.get(`https://www.youtube.com/oembed?url=${url}&format=json`);
      const { title, thumbnail_url } = response.data;
      // oEmbed doesn't always provide duration, we'll use 0 or default
      return { 
        title: title || 'Unknown Title', 
        thumbnail: thumbnail_url || '', 
        duration: 0 
      };
    } catch (e) {
      const videoId = url.split('v=')[1]?.split('&')[0];
      return { 
        title: videoId ? `Video ${videoId}` : 'Invalid URL', 
        thumbnail: videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : '', 
        duration: 0 
      };
    }
  }

  async addTrack(roomId: string, youtubeUrl: string, userId: string, duration?: number): Promise<{ track: Track | null; error?: string }> {
    const room = this.rooms.get(roomId);
    if (!room) return { track: null, error: 'ROOM_NOT_FOUND' };

    // 1. Check user track limit (max 4 tracks in queue)
    const userTrackCount = room.queue.filter(t => t.addedBy === userId).length;
    if (userTrackCount >= 4) {
      return { track: null, error: 'TRACK_LIMIT_REACHED' };
    }

    const metadata = await this.fetchYoutubeMetadata(youtubeUrl);
    
    const newTrack: Track = {
      trackId: uuidv4(),
      youtubeUrl,
      addedBy: userId,
      ...metadata,
      duration: duration || metadata.duration || 0, // Priority to client provided duration
      hearts: [],
      addedAt: Date.now(),
    };

    if (!room.currentTrack) {
      room.currentTrack = newTrack;
      room.playbackState.isPlaying = true;
      room.playbackState.lastUpdated = Date.now();
      room.playbackState.currentTime = 0;
      this.stopInactivityTimer(roomId); 
      this.scheduleTrackEnd(roomId);
    } else {
      room.queue.push(newTrack);
      this.resetInactivityTimer(roomId); // Activity detected
    }

    return { track: newTrack };
  }

  removeTrack(roomId: string, trackId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const user = room.users.find((u) => u.userId === userId);
    if (!user) return false;

    const trackIndex = room.queue.findIndex((t) => t.trackId === trackId);
    if (trackIndex === -1) return false;

    const track = room.queue[trackIndex];

    // Admin can delete any, user can delete their own
    if (user.role === 'admin' || track.addedBy === userId) {
      room.queue.splice(trackIndex, 1);
      this.resetInactivityTimer(roomId);
      return true;
    }

    return false;
  }

  updatePlayback(roomId: string, userId: string, state: Partial<PlaybackState>): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const user = room.users.find(u => u.userId === userId);
    // Only the designated player or the admin can update playback (Play/Pause)
    if (!user || (!user.canPlay && user.role !== 'admin')) return false;

    room.playbackState = {
      ...room.playbackState,
      ...state,
      lastUpdated: Date.now(),
    };

    // Update timer based on new state
    if (room.playbackState.isPlaying) {
      this.stopInactivityTimer(roomId);
    } else {
      this.resetInactivityTimer(roomId); // Start counting down inactivity when paused
    }

    return true;
  }

  syncPlayback(roomId: string, userId: string, isPlaying: boolean, currentTime: number) {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    room.playbackState.isPlaying = isPlaying;
    room.playbackState.currentTime = currentTime;
    room.playbackState.lastUpdated = Date.now();

    if (!room.playbackState.isPlaying) {
      this.clearTrackTimer(roomId);
      this.resetInactivityTimer(roomId);
    } else {
      this.stopInactivityTimer(roomId);
      this.scheduleTrackEnd(roomId);
    }

    return true;
  }

  reorderQueue(roomId: string, userId: string, fromIndex: number, toIndex: number): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const user = room.users.find((u) => u.userId === userId);
    // Only someone with control rights or the admin can reorder the queue
    if (!user || (!user.canControl && user.role !== 'admin')) return false;

    if (
      fromIndex < 0 || fromIndex >= room.queue.length ||
      toIndex < 0 || toIndex >= room.queue.length
    ) {
      return false;
    }

    const [movedTrack] = room.queue.splice(fromIndex, 1);
    room.queue.splice(toIndex, 0, movedTrack);

    return true;
  }
  transferAdmin(roomId: string, currentAdminId: string, newAdminId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    if (room.adminId !== currentAdminId) return false;

    const currentAdmin = room.users.find((u) => u.userId === currentAdminId);
    const targetUser = room.users.find((u) => u.userId === newAdminId);

    if (!currentAdmin || !targetUser) return false;

    currentAdmin.role = 'user';
    targetUser.role = 'admin';
    room.adminId = newAdminId;
    
    // Also grant control to new admin if they didn't have it
    targetUser.canControl = true;

    return true;
  }

  setControlPermission(roomId: string, requesterId: string, targetUserId: string, canControl: boolean): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.adminId !== requesterId) return false;

    const targetUser = room.users.find(u => u.userId === targetUserId);
    if (!targetUser) return false;

    targetUser.canControl = canControl;
    return true;
  }

  setPlayerPermission(roomId: string, requesterId: string, targetUserId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.adminId !== requesterId) return false;

    // Reset all playback permissions - only one playback source allowed
    room.users.forEach(u => u.canPlay = false);

    const targetUser = room.users.find(u => u.userId === targetUserId);
    if (!targetUser) return false;

    targetUser.canPlay = true;
    return true;
  }

  nextTrack(roomId: string): Track | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    if (room.queue.length > 0) {
      room.currentTrack = room.queue.shift() || null;
      room.playbackState.currentTime = 0;
      room.playbackState.lastUpdated = Date.now();
      room.playbackState.isPlaying = true;
      this.stopInactivityTimer(roomId);
      this.scheduleTrackEnd(roomId);
    } else {
      room.currentTrack = null;
      room.playbackState.isPlaying = false;
      this.clearTrackTimer(roomId);
      this.resetInactivityTimer(roomId); // Start inactivity timer if queue is empty
    }

    return room.currentTrack;
  }

  heartTrack(roomId: string, trackId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    // 1. Remove heart from ALL tracks in the queue for this user
    room.queue.forEach((track) => {
      const index = track.hearts.indexOf(userId);
      if (index !== -1) {
        track.hearts.splice(index, 1);
      }
    });

    // 2. Add heart to the target track
    const targetTrack = room.queue.find((t) => t.trackId === trackId);
    if (targetTrack) {
      targetTrack.hearts.push(userId);
    } else {
      return false;
    }

    // 3. Re-sort queue: most hearts at the top, then FIFO (earlier addedAt first)
    room.queue.sort((a, b) => {
      // Sort by heart count (descending)
      if (b.hearts.length !== a.hearts.length) {
        return b.hearts.length - a.hearts.length;
      }
      // If heart counts are equal, sort by addedAt (ascending - earlier first)
      return a.addedAt - b.addedAt;
    });

    return true;
  }
}
