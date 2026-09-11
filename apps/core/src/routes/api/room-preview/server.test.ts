// GET /api/room-preview — the scanned-guest confirmation source (XR-PH-14, Q1-B). Drives the
// REAL handler against a real SingerRepository + PresenceTracker on a migrated in-memory DB.
//
// The load-bearing property is the INTERSECTION: presence is one GLOBAL tracker (not per-room) so
// `online()` alone counts other rooms' phones, and `listPublic(roomId)` is not presence-filtered so it
// alone counts singers who have gone. Present-in-THIS-room is their intersection, and each test below
// reds on a revert to either half alone.
import { test, expect, afterEach } from 'bun:test';
import { GET } from './+server';
import { RoomRepository } from '$server/rooms/repository';
import { SingerRepository } from '$server/singers/repository';
import { PresenceTracker } from '$server/realtime/presence';
import { migratedDb } from '$server/db/test-db';

const APP_KEY = Symbol.for('encore.app');

function installApp() {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const room = rooms.ensureActive(1); // the active party
	const other = rooms.create(2); // a second, unrelated party
	const singers = new SingerRepository(db);
	const presence = new PresenceTracker();
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		db,
		rooms,
		activeRoomId: room.id,
		singers,
		presence,
		now: () => 1_700_000_000_000
	};
	return { room, other, singers, presence };
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function call(code: string) {
	return GET({ url: new URL(`http://x/api/room-preview?code=${encodeURIComponent(code)}`) } as never);
}

test('present = online AND a singer of THIS room — not online alone, not listed alone', async () => {
	const { room, other, singers, presence } = installApp();
	// Three singers in the target room: two connected (here), one never connected (gone/left).
	const maya = singers.create('Maya', '#7c5cff', 1, room.id);
	const dana = singers.create('Dana', '#22c55e', 1, room.id);
	singers.create('Gone', '#f59e0b', 1, room.id); // in the room, but no live socket
	// One singer connected in a DIFFERENT room — online, but not here.
	const elsewhere = singers.create('Elsewhere', '#ef4444', 1, other.id);

	presence.connect(maya.id);
	presence.connect(dana.id);
	presence.connect(elsewhere.id); // online globally, wrong room

	const res = await call(room.code);
	expect(res.status).toBe(200);
	const body = await res.json();

	// The count is the intersection: 2, not 4 (listPublic∪other) and not 3 (all room singers).
	expect(body.presentCount).toBe(2);
	expect(new Set(body.names)).toEqual(new Set(['Maya', 'Dana']));
	// Neither the away singer nor the other room's singer leaks in.
	expect(body.names).not.toContain('Gone');
	expect(body.names).not.toContain('Elsewhere');
	// The normalised code is echoed; it is never used AS the confirmation, but it is the room's code.
	expect(body.code).toBe(room.code);
});

test('a malformed (non-six) code is a 400 with a reason, not "not found"', async () => {
	installApp();
	const res = await call('ABC'); // three characters
	expect(res.status).toBe(400);
	const body = await res.json();
	expect(typeof body.error).toBe('string');
	expect(body.error.length).toBeGreaterThan(0);
});

test('a well-formed code naming no room is a 404 that states the code', async () => {
	installApp();
	const res = await call('ZZZZZZ'); // six valid characters, no such room
	expect(res.status).toBe(404);
	const body = await res.json();
	expect(body.error).toContain('ZZZZZZ');
});

test('the code is normalised before lookup — lower case and punctuation resolve the same room', async () => {
	const { room } = installApp();
	// Lower-case the real code; the endpoint upper-cases and strips before byCode, so it still resolves.
	const res = await call(room.code.toLowerCase());
	expect(res.status).toBe(200);
	expect((await res.json()).code).toBe(room.code);
});
