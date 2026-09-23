// Room isolation — the ONE place answering "which room is this socket in, and may it touch the room
// the core is serving?". State (playback, queue, rotation, roster) is keyed per room, but the wire is
// still one shared pub/sub channel (ROOM_TOPIC) — without this check a broadcast for room A reaches
// room B's clients, and a command from a room-B phone mutates room A's queue. A room is a tenancy boundary,
// not a decorative label.
//
// The SCOPE TOKEN is the phone's existing session token (singers.session_token, not a new
// credential): it resolves via the singers row to exactly one room_id (NOT NULL on every singer), so
// the token presented at WS upgrade binds a socket to one room, and ONLY that token — room identity
// is never inferred from anything else the socket sends.
//
// Three classes against the served room (servedRoomId):
//   • IN-ROOM   — scoped to it. Full read + mutate; hears its broadcasts.
//   • FOREIGN   — scoped to a DIFFERENT room. Refused every read/mutation here, subscribed to its
//                 OWN room's topic only — so it can neither act on nor overhear this party.
//   • SPECTATOR — no room (unbound TV, unjoined phone, a probe). A legitimate VIEWER (hears
//                 broadcasts, gets `hello` resync) but still refused mutation by the per-command
//                 gates (`join the room first`, `player:control`). Isolation is BETWEEN rooms; an
//                 unscoped viewer of the served room is not a cross-room leak.
//
// Exactly ONE room served in memory today (app.activeRoomId). If that changes, `servedRoomId`
// becomes per-request and every decision here still holds.

import { roomTopic } from '../../contract';

/** The room a socket is scoped to, resolved from its session token at WS upgrade. `undefined` =
 *  never joined (a spectator, see the class list above). */
export type SocketRoomId = string | undefined;

/**
 * FOREIGN to the served room = names a DIFFERENT room (a spectator, with no room, is NOT foreign —
 * it's an unscoped viewer). The gate every read/mutation of the served room passes through, so a
 * room-B phone can't see or change room A. Centralised here, like `can()`, so tenancy lives in one place.
 */
export function isForeignRoom(socketRoomId: SocketRoomId, servedRoomId: string): boolean {
	return socketRoomId !== undefined && socketRoomId !== servedRoomId;
}

/**
 * The pub/sub topic this socket subscribes to: its OWN room if scoped (so a foreign socket never
 * lands on the served room's topic), else the served room (so an unscoped spectator still hears it).
 */
export function subscribeTopicFor(socketRoomId: SocketRoomId, servedRoomId: string): string {
	return roomTopic(socketRoomId ?? servedRoomId);
}

/** The topic the core broadcasts a served room's events on — ONLY `roomTopic(servedRoomId)`, which
 *  a foreign room's sockets never subscribed to (see subscribeTopicFor). */
export function broadcastTopicFor(servedRoomId: string): string {
	return roomTopic(servedRoomId);
}
