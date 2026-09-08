// #658 one-TV-per-room — the pure decision test for which room a TV binds to. Socket-free, like
// room-scope.test.ts. Two rooms A and B on a box serving A (activeRoomId = A).
//
// On BASE (pre-#658) this module does not exist: a TV carries no roomId at all and is an unscoped
// spectator of the served room, so "point the TV at room B" is not expressible. The binding these
// tests assert is exactly what the PR adds.
import { test, expect } from 'bun:test';
import { tvRoomId } from './tv-room';

const A = 'room-A';
const B = 'room-B';
const rooms: Record<string, { id: string }> = { AAAAAA: { id: A }, BBBBBB: { id: B } };
const byCode = (code: string) => rooms[code] ?? null;

test('a bare /tv (no room code) binds to the served room — todays spectator behaviour', () => {
	expect(tvRoomId(undefined, byCode, A)).toBe(A);
	expect(tvRoomId(null, byCode, A)).toBe(A);
	expect(tvRoomId('', byCode, A)).toBe(A);
});

test('an explicit ?room=<code> for a REAL room binds the TV to THAT room, not the served one', () => {
	// The whole point of #658: a TV can be aimed at a specific party. Pointed at B while the box
	// serves A, it resolves B (downstream it is then foreign to A — it has no A state to show).
	expect(tvRoomId('BBBBBB', byCode, A)).toBe(B);
	// and pointed at the served room own code it resolves the served room (IN-ROOM, hears A).
	expect(tvRoomId('AAAAAA', byCode, A)).toBe(A);
});

test('an UNKNOWN code falls back to the served room rather than binding to nothing', () => {
	// A stale or mistyped code must not dark-screen the TV; it shows the room the box serves.
	expect(tvRoomId('NOSUCH', byCode, A)).toBe(A);
});

test('the resolver never returns undefined — a TV is always bound to exactly one room', () => {
	for (const code of [undefined, null, '', 'AAAAAA', 'BBBBBB', 'NOSUCH'] as const) {
		expect(typeof tvRoomId(code, byCode, A)).toBe('string');
	}
});
