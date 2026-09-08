// Room isolation — the ONE place that answers "which room is this socket in, and may it touch the
// room the core is serving?".
//
// The chain up to here made the DATA per-room: #655 keyed playback by room, #656 keyed the queue,
// rotation and roster. But the wire was still a single shared channel — one pub/sub topic for the
// whole deployment (ROOM_TOPIC) and no check that the singer behind a socket belongs to the room the
// core is serving. So with two rooms on one box, a broadcast for room A reached room B's clients, and
// a queue/player command from a room-B phone mutated room A's queue. That is the isolation gap #657
// closes, and it is security-relevant: a room is a tenancy boundary, not a decorative label.
//
// The SCOPE TOKEN is the session token a phone already carries (singers.session_token). It is not a
// new credential: it resolves — via the singers row — to exactly one room_id (#656 made room_id NOT
// NULL on every singer), so the token a socket presents at the WS upgrade binds that socket to one
// room and one only. This module turns that binding into the decisions the wire layer needs.
//
// A socket falls into one of THREE classes against the room the core is serving (servedRoomId):
//   • IN-ROOM  — scoped to the served room. Full read + mutate; hears the served room's broadcasts.
//   • FOREIGN  — scoped to a DIFFERENT, non-null room. Refused every read and mutation of the served
//                room, and subscribed to its OWN room's topic, never the served room's — so it can
//                neither act on nor overhear this party.
//   • SPECTATOR — no room at all (a TV before #658 binds it to a room, a phone that has not joined,
//                a probe). It is a legitimate VIEWER of the served room: it subscribes to and hears
//                the served room's broadcasts and its `hello` resync is answered, but it may not
//                mutate — the per-command `join the room first` / `player:control` gates still refuse
//                that, exactly as before #657. Isolation is BETWEEN rooms; an unscoped viewer of the
//                one room this box serves is not a cross-room leak. #658 (one-TV-per-room) is what
//                later binds the TV to a specific room.
//
// The core serves exactly ONE room in memory today (app.activeRoomId — the single AuthoritativeState
// instance #655/#656 bind to that room). When a later milestone runs several rooms' state in one
// process, `servedRoomId` becomes a per-request value rather than a constant and every decision here
// still holds unchanged.

import { roomTopic } from '@encore/shared';

/**
 * The room a socket is scoped to, resolved from its session token at the WS upgrade. `undefined`
 * means the socket never joined — a spectator (see the class list above).
 */
export type SocketRoomId = string | undefined;

/**
 * Is this socket FOREIGN to the room the core is serving — i.e. bound to a DIFFERENT party? True only
 * when the socket names a room AND it is not the served one. A spectator (no room) is NOT foreign: it
 * is an unscoped viewer of the served room, not a cross-room actor. This is the gate the wire layer
 * puts in front of every read/mutation of the served room, so a room-B phone cannot see or change
 * room A. Centralised here — like `can()` for capability — so the tenancy rule lives in one testable
 * place rather than being re-derived at each seam.
 */
export function isForeignRoom(socketRoomId: SocketRoomId, servedRoomId: string): boolean {
	return socketRoomId !== undefined && socketRoomId !== servedRoomId;
}

/**
 * The pub/sub topic this socket subscribes to. A scoped socket hears its OWN room (so a foreign one
 * lands on its own room's topic, never the served room's — the delivery half of isolation). An
 * unscoped spectator defaults to the served room, so a TV watching the one room this box serves still
 * receives its broadcasts. Never returns another room's topic for the served room's events.
 */
export function subscribeTopicFor(socketRoomId: SocketRoomId, servedRoomId: string): string {
	return roomTopic(socketRoomId ?? servedRoomId);
}

/**
 * The topic the core broadcasts a served room's events on. The publish half of isolation: an event
 * for `servedRoomId` goes ONLY to `roomTopic(servedRoomId)`, which only that room's sockets (plus the
 * served room's spectators) subscribed to (see subscribeTopicFor) — so it never reaches a foreign
 * room's sockets, which are on their own room's topic.
 */
export function broadcastTopicFor(servedRoomId: string): string {
	return roomTopic(servedRoomId);
}
