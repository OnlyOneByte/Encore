// POST /api/join must carry a room code through to doJoin, refuse an unknown code with 404, and return
// the room the join landed in to the caller. These drive the REAL POST handler against a
// real RoomRepository + SingerRepository on an in-memory migrated DB, so the pinned mechanism is
// end-to-end: the request's `code` reaches the room resolution and the resolved roomId reaches the response body.
//
// A cleanup removed the second cookie this route used to set (`encore_room`), which had no reader anywhere:
// the room a socket may act in is derived from the session token via the singers row, never from a
// client-supplied value (see $lib/server/realtime/room-scope). So the cookie assertions here pin the
// COOKIE SET ITSELF — exactly one cookie, the session one — rather than naming the deleted constant,
// which makes re-adding any second cookie on this path red regardless of what it is called.
//
// BASE-RED: on origin/main the route neither reads `code` nor returns a roomId, and it sets TWO cookies.
import { test, expect, afterEach } from 'bun:test';
import { POST } from '$routes/api/join/+server';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SingerRepository, SESSION_COOKIE } from '$lib/server/singers/repository';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { AuthoritativeState } from '$lib/server/state/store';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { migratedDb } from '$lib/server/db/test-db';

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

test('joining with a room code lands in THAT room — the body carries its id, and only ONE cookie is set', async () => {
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
	// The room id reaches the phone in the BODY. It must not also be handed back as a cookie: a
	// client-supplied room id is exactly the mechanism room isolation refused, and the old room cookie never had a
	// reader. Asserting the whole key set (not the absence of one name) catches a re-add under any name.
	expect(Object.keys(set)).toEqual([SESSION_COOKIE]);
	expect(set[SESSION_COOKIE]).toBeString();
	// and the room id specifically is nowhere in the jar
	expect(Object.values(set)).not.toContain(other.id);
});

test('an unknown room code is refused with 404 and sets no cookies', async () => {
	const db = migratedDb();
	const rooms = installApp(db, 'ignored-default');
	rooms.ensureActive(1);

	const { jar, set } = cookieJar();
	const res = await post({ displayName: 'Kai', color: '#00aaff', code: 'NOSUCH' }, jar);
	expect(res.status).toBe(404);
	expect(Object.keys(set)).toEqual([]);
});
