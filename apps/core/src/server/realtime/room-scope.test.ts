// room isolation — the deterministic two-room proof for the pure decision layer.
//
// Two parties, A and B, on ONE core that is authoritatively serving room A (servedRoomId = A). The
// isolation contract this file pins, all decidable without a socket:
//   1. a socket scoped to room B is FOREIGN to room A — its reads/mutations of room A are refused;
//   2. a socket scoped to room A is NOT foreign — it may act;
//   3. an unscoped spectator is NOT foreign — a TV watching the served room is a viewer, not a leak;
//   4. the pub/sub topics for A and B are DISTINCT, so a publish to one is unheard on the other;
//   5. a room-B socket subscribes to B's topic (never A's) and A's broadcasts go to A's topic — so a
//      broadcast in room A reaches only room-A (and served-room spectator) sockets.
//
// On BASE (before the session token became the room identity) this module does not exist and there is
// check, so none of this is expressible — the isolation it asserts is exactly what the PR adds.
import { test, expect } from 'bun:test';
import { roomTopic } from '@encore/shared';
import { isForeignRoom, subscribeTopicFor, broadcastTopicFor } from './room-scope';

const A = 'room-A';
const B = 'room-B';

test('a room-B socket is FOREIGN to the served room A — its reads/mutations are refused', () => {
	// The core serves A; a phone whose session token scoped it to B may not read or mutate A.
	expect(isForeignRoom(B, A)).toBe(true);
});

test('a room-A socket is NOT foreign to the served room A — it may act', () => {
	expect(isForeignRoom(A, A)).toBe(false);
});

test('an unscoped spectator (no room) is NOT foreign — a TV viewing the served room passes', () => {
	// Isolation is BETWEEN rooms; an unscoped viewer of the one room this box serves is not a
	// cross-room actor. (Its mutations are still stopped downstream by the join/player gates.)
	expect(isForeignRoom(undefined, A)).toBe(false);
});

test('two rooms get DISTINCT pub/sub topics — a publish to one is unheard on the other', () => {
	expect(roomTopic(A)).not.toBe(roomTopic(B));
	// and the topic is derived from the room id, so two ids deterministically diverge.
	expect(roomTopic(A)).toBe('room:room-A');
	expect(roomTopic(B)).toBe('room:room-B');
});

test('a broadcast in room A reaches ONLY room-A sockets, never room B (topic routing)', () => {
	// The publish half: A's events go to A's topic.
	const aBroadcast = broadcastTopicFor(A);
	// A room-A socket subscribes to A's topic → it hears A's broadcast.
	expect(subscribeTopicFor(A, A)).toBe(aBroadcast);
	// A room-B socket subscribes to B's topic, which is NOT A's → it never hears A's broadcast.
	expect(subscribeTopicFor(B, A)).not.toBe(aBroadcast);
	expect(subscribeTopicFor(B, A)).toBe(roomTopic(B));
});

test('a served-room spectator (no room) subscribes to the served room, so a TV still sees room A', () => {
	// An unscoped socket defaults to the served room's topic — the TV of the one served room hears it,
	// but this is the SERVED room, never a foreign one: a spectator can only ever default to A here.
	expect(subscribeTopicFor(undefined, A)).toBe(broadcastTopicFor(A));
});

test('the reverse also holds: serving B, a room-A socket is foreign and lands on A topic not B', () => {
	// Symmetry — isolation is not one-directional. Serve B; an A socket cannot touch B and is on A's topic.
	expect(isForeignRoom(A, B)).toBe(true);
	expect(subscribeTopicFor(A, B)).toBe(roomTopic(A));
	expect(subscribeTopicFor(A, B)).not.toBe(broadcastTopicFor(B));
});
