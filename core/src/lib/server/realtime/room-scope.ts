// The ONE place answering "which room is this socket in, and may it touch the served room?". State is keyed
// per room but the wire is one shared pub/sub channel, so without this check a broadcast for room A reaches
// room B's clients and a room-B phone mutates room A's queue. A room is a TENANCY BOUNDARY.
//
// The SCOPE TOKEN is the phone's existing session token, which resolves via the singers row to exactly one
// room_id: room identity is NEVER inferred from anything else the socket sends.
//
// Three classes against `servedRoomId`: IN-ROOM reads and mutates; FOREIGN is refused both and subscribed
// only to its OWN topic; SPECTATOR (no room) is a legitimate VIEWER still refused mutation by the per-command
// gates — isolation is BETWEEN rooms, and an unscoped viewer of the served room is not a cross-room leak.

import { roomTopic, roomTvTopic } from '../../contract';

/** Resolved from the session token at WS upgrade. `undefined` = never joined, i.e. a spectator. */
export type SocketRoomId = string | undefined;

/** FOREIGN = names a DIFFERENT room; a spectator with no room is NOT foreign. The gate every read and
 *  mutation of the served room passes through, centralised here so tenancy lives in one place. */
export function isForeignRoom(socketRoomId: SocketRoomId, servedRoomId: string): boolean {
	return socketRoomId !== undefined && socketRoomId !== servedRoomId;
}

/** Its OWN room if scoped, so a foreign socket never lands on the served room's topic; else the served
 *  room, so an unscoped spectator still hears it. */
export function subscribeTopicFor(socketRoomId: SocketRoomId, servedRoomId: string): string {
	return roomTopic(socketRoomId ?? servedRoomId);
}

/** ONLY `roomTopic(servedRoomId)`, which a foreign room's sockets never subscribed to. */
export function broadcastTopicFor(servedRoomId: string): string {
	return roomTopic(servedRoomId);
}

/** The TV-only topic a socket ALSO subscribes to, or null. Only `role=tv` gets one, which is the whole guarantee
 *  that a TV-only frame (`room:reacted`) never reaches a phone: Bun delivers a topic only to its subscribers. */
export function tvTopicFor(role: string, socketRoomId: SocketRoomId, servedRoomId: string): string | null {
	return role === 'tv' ? roomTvTopic(socketRoomId ?? servedRoomId) : null;
}
