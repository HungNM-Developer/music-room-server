import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { RevokeReason, ServerEvents } from '../contracts';
import { PresenceService } from './presence.service';

type EventName = keyof ServerEvents;
type EventData<E extends EventName> = Parameters<ServerEvents[E]>[0];

export const roomChannel = (roomId: string) => `room:${roomId}`;

/** Thin wrapper over the Socket.IO server so domain services never touch sockets directly. */
@Injectable()
export class Broadcaster {
  private server: Server | null = null;

  constructor(private readonly presence: PresenceService) {}

  attach(server: Server): void {
    this.server = server;
  }

  toRoom<E extends EventName>(
    roomId: string,
    event: E,
    data: EventData<E>,
  ): void {
    this.server?.to(roomChannel(roomId)).emit(event, data);
  }

  toSocket<E extends EventName>(
    socketId: string,
    event: E,
    data: EventData<E>,
  ): void {
    this.server?.to(socketId).emit(event, data);
  }

  toMember<E extends EventName>(
    memberId: string,
    event: E,
    data: EventData<E>,
  ): void {
    for (const id of this.presence.socketsOf(memberId))
      this.toSocket(id, event, data);
  }

  /** Every socket signed in to the account, whatever room (or none) it is in. */
  toUser<E extends EventName>(
    userId: string,
    event: E,
    data: EventData<E>,
  ): void {
    for (const socket of this.server?.sockets.sockets.values() ?? [])
      if ((socket.data as { userId?: string }).userId === userId)
        socket.emit(event, data);
  }

  /**
   * The room is gone: tell every socket bound to it (members and the speaker page) why, and
   * drop it. `unbind` must see nothing left to clean, so the binding is cleared first.
   * `quietSocketId`: the socket that asked; it is only detached, so its answer still arrives.
   */
  evictRoom(
    roomId: string,
    reason: RevokeReason,
    quietSocketId?: string,
  ): number {
    let n = 0;
    for (const socket of this.server?.sockets.sockets.values() ?? []) {
      const bound = (socket.data as { bound?: { roomId: string } }).bound;
      if (bound?.roomId !== roomId) continue;
      (socket.data as { bound?: unknown }).bound = undefined;
      this.presence.remove(socket.id);
      void socket.leave(roomChannel(roomId));
      if (socket.id === quietSocketId) continue;
      socket.emit('session:revoked', { reason });
      socket.disconnect(true);
      n += 1;
    }
    return n;
  }

  /** R-10 / R-11: tell every tab of the member why, then drop the sockets. */
  revokeMember(memberId: string, reason: RevokeReason): void {
    for (const id of this.presence.socketsOf(memberId)) {
      this.toSocket(id, 'session:revoked', { reason });
      this.server?.sockets.sockets.get(id)?.disconnect(true);
    }
  }
}
