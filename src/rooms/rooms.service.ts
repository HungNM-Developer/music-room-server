import { Injectable } from '@nestjs/common';
import { Room, User, Track, PlaybackState } from './types';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

@Injectable()
export class RoomsService {
  private rooms: Map<string, Room> = new Map();
  private colors = [
    '#FF5733', '#33FF57', '#3357FF', '#F333FF', '#33FFF3', 
    '#FFC300', '#DAF7A6', '#C70039', '#900C3F', '#581845'
  ];

  private getRandomColor() {
    return this.colors[Math.floor(Math.random() * this.colors.length)];
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
    };

    room.users.push(user);
    return { room, user };
  }

  leaveRoom(socketId: string): { roomId: string; room: Room | null } | null {
    for (const [roomId, room] of this.rooms.entries()) {
      const userIndex = room.users.findIndex((u) => u.socketId === socketId);
      if (userIndex !== -1) {
        const [user] = room.users.splice(userIndex, 1);
        
        // Scenario 1: Room becomes empty
        if (room.users.length === 0) {
          this.rooms.delete(roomId);
          return { roomId, room: null }; // Room is gone
        }

        // Scenario 2: Admin leaves but others are still there
        if (user.role === 'admin') {
          room.users[0].role = 'admin';
          room.adminId = room.users[0].userId;
        }
        
        return { roomId, room };
      }
    }
    return null;
  }

  getRoom(roomId: string): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;

    // Return a clone with adjusted time
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

  async addTrack(roomId: string, youtubeUrl: string, userId: string): Promise<Track | null> {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const metadata = await this.fetchYoutubeMetadata(youtubeUrl);
    
    const newTrack: Track = {
      trackId: uuidv4(),
      youtubeUrl,
      addedBy: userId,
      ...metadata,
    };

    if (!room.currentTrack) {
      room.currentTrack = newTrack;
      room.playbackState.isPlaying = true;
      room.playbackState.lastUpdated = Date.now();
      room.playbackState.currentTime = 0;
    } else {
      room.queue.push(newTrack);
    }

    return newTrack;
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
      return true;
    }

    return false;
  }

  updatePlayback(roomId: string, userId: string, state: Partial<PlaybackState>): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const user = room.users.find(u => u.userId === userId);
    if (!user || user.role !== 'admin') return false;

    room.playbackState = {
      ...room.playbackState,
      ...state,
      lastUpdated: Date.now(),
    };

    return true;
  }

  reorderQueue(roomId: string, userId: string, fromIndex: number, toIndex: number): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const user = room.users.find((u) => u.userId === userId);
    if (!user || user.role !== 'admin') return false;

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

    // Verify current requester is the admin
    if (room.adminId !== currentAdminId) return false;

    const currentAdmin = room.users.find((u) => u.userId === currentAdminId);
    const targetUser = room.users.find((u) => u.userId === newAdminId);

    if (!currentAdmin || !targetUser) return false;

    // Swap roles
    currentAdmin.role = 'user';
    targetUser.role = 'admin';
    room.adminId = newAdminId;

    return true;
  }

  shareAdmin(roomId: string, requesterId: string, targetUserId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    // Only existing admins can share admin rights
    const requester = room.users.find((u) => u.userId === requesterId);
    if (!requester || requester.role !== 'admin') return false;

    const targetUser = room.users.find((u) => u.userId === targetUserId);
    if (!targetUser) return false;

    targetUser.role = 'admin';
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
    } else {
      room.currentTrack = null;
      room.playbackState.isPlaying = false;
    }

    return room.currentTrack;
  }
}
