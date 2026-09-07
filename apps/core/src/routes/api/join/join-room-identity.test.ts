// POST /api/join must carry a room code through to doJoin, refuse an unknown code with 404, and set the room cookie to the room the join landed in (#654). These drive the REAL POST handler against a
// real RoomRepository + SingerRepository on an in-memory migrated DB, so the pinned mechanism is
// end-to-end: the request's `code` reaches the room resolution and the resolved roomId reaches both
// the cookie and the response body.
//
// BASE-RED: on origin/main the route neither reads `code` nor sets a room cookie nor returns a roomId,
// so every assertion below inverts.
import { test, expect, afterEach } from 'bun:test';
import { POST } from './+server';
import { RoomRepository } from '$server/rooms/repository';
import { SingerRepository, ROOM_COOKIE, SESSION_COOKIE } from '$server/singers/repository';
import { PresenceTracker } from '$server/realtime/presence';
import { AuthoritativeState } from '$server/state/store';
import { SettingsRepository } from '$server/state/settings-repository';
import { migratedDb } from '$server/db/test-db';

const APP_KEY = Symbol.for('encore.app');

function installApp(db: ReturnType<typeof migratedDb>, activeRoomId: string) {
	const rooms = new RoomRepository(db);
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		db,
		rooms,
		activeRoomId,
		singers: new SingerRepository(db),
		presence: new PresenceTracker(),
		state: new AuthoritativeState(),
		settings: new SettingsRepository(db),
		now: () => 1_700_000_000_000,
		publish: () => {}
	};
	return rooms;
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

/** A cookies stub that records every set() so the test can assert what the handler stored. */
function cookieJar() {
	const set: Record<string, string> = {};
	return {
		jar: { get: () => undefined, set: (k: string, v: string) => (set[k] = v), delete: () => {} },
		set
	};
}

function post(body: unknown, cookies: ReturnType<typeof cookieJar>['jar']) {
	const url = new URL('http://x/api/join');
	const request = new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', host: 'x' },
		body: JSON.stringify(body)
	});
	return POST({ request, cookies, url } as never);
}

test('joining with a room code lands in THAT room — cookie and body both carry its id', async () => {
	const db = migratedDb();
	const rooms = installApp(db, 'ignored-default');
	const active = rooms.ensureActive(1); // the bare-join default
	const other = rooms.create(2); // the party whose QR was scanned
	expect(other.id).not.toBe(active.id);

	const { jar, set } = cookieJar();
	const res = await post({ displayName: 'Maya', color: '#ff5cae', code: other.code }, jar);
	expect(res.status).toBe(200);

	const payload = (await res.json()) as { roomId: string };
	expect(payload.roomId).toBe(other.id);
	expect(set[ROOM_COOKIE]).toBe(other.id);
	expect(set[SESSION_COOKIE]).toBeString();
});

test('an unknown room code is refused with 404 and sets no cookies', async () => {
	const db = migratedDb();
	const rooms = installApp(db, 'ignored-default');
	rooms.ensureActive(1);

	const { jar, set } = cookieJar();
	const res = await post({ displayName: 'Kai', color: '#00aaff', code: 'NOSUCH' }, jar);
	expect(res.status).toBe(404);
	expect(set[ROOM_COOKIE]).toBeUndefined();
	expect(set[SESSION_COOKIE]).toBeUndefined();
});
