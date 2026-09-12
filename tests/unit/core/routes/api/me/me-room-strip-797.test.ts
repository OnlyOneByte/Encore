// F2 — /api/me projects a StoredSinger onto the wire, so it must drop `room_id`, not only the
// session token.
//
// `singers` rows carry `room_id`. Both handlers here destructured only `sessionToken` off the
// row, so `roomId` rode along in the GET body, in the PATCH body, and — the sharp one — inside the
// `singer:updated` frame, whose declared type is `PublicSinger` and has no room field. TypeScript
// could not catch that: `safe` is a variable, and an excess-property check only fires on an inline
// object literal.
//
// These drive the REAL handlers against a real SingerRepository on an in-memory migrated DB and
// compare the emitted key set against `PublicSinger`'s own keys, taken from a value typed as
// `PublicSinger` rather than hard-coded — so the assertion tracks the wire type if it ever gains a
// field, instead of pinning today's list twice.
//
// BASE-RED: on origin/main every key-set assertion below reports an extra `roomId`.
import { test, expect, afterEach } from 'bun:test';
import { GET, PATCH } from '../../../../../../apps/core/src/routes/api/me/+server';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SingerRepository } from '$lib/server/singers/repository';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { AuthoritativeState } from '$lib/server/state/store';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { migratedDb } from '$lib/server/db/test-db';
import type { PublicSinger, ServerEvent } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');

/** The wire contract, read off the TYPE rather than restated: whatever `PublicSinger` declares. */
const PUBLIC_SINGER_KEYS: readonly string[] = Object.keys({
	id: 'x',
	displayName: 'x',
	color: '#ffffff',
	joinedAt: 0,
	lastSungAt: null
} satisfies PublicSinger).sort();

function installApp(db: ReturnType<typeof migratedDb>) {
	const rooms = new RoomRepository(db);
	const room = rooms.ensureActive(1);
	const singers = new SingerRepository(db);
	const published: ServerEvent[] = [];
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		db,
		rooms,
		activeRoomId: room.id,
		singers,
		presence: new PresenceTracker(),
		state: new AuthoritativeState(),
		settings: new SettingsRepository(db),
		now: () => 1_700_000_000_000,
		publish: (e: ServerEvent) => published.push(e)
	};
	return { room, singers, published };
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

/** A cookies stub carrying one session token, matching what a joined phone sends. */
function jarFor(token: string) {
	return { get: () => token, set: () => {}, delete: () => {} };
}

function patch(body: unknown, token: string) {
	const url = new URL('http://x/api/me');
	const request = new Request(url, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', host: 'x' },
		body: JSON.stringify(body)
	});
	return PATCH({ request, cookies: jarFor(token), url } as never);
}

test('F2 non-vacuous: the STORED row really carries roomId, so there is something to strip', () => {
	// Without this the three assertions below would also pass on a repository that had stopped storing
	// the column at all, which is a different (and worse) tree than the one being pinned.
	const db = migratedDb();
	const { room, singers } = installApp(db);
	const created = singers.create('Maya', '#ff5cae', 1_700_000_000_000, room.id);
	const stored = singers.byId(created.id)!;
	expect(stored.roomId).toBe(room.id);
	expect(Object.keys(stored)).toContain('roomId');
	// and the wire contract this is measured against is the real one
	expect(PUBLIC_SINGER_KEYS).not.toContain('roomId');
	expect(PUBLIC_SINGER_KEYS).toContain('displayName');
});

test('F2 GET /api/me returns the wire shape — no roomId, no sessionToken', async () => {
	const db = migratedDb();
	const { room, singers } = installApp(db);
	const created = singers.create('Maya', '#ff5cae', 1_700_000_000_000, room.id);

	const res = await GET({ cookies: jarFor(created.sessionToken) } as never);
	expect(res.status).toBe(200);
	const { singer } = (await res.json()) as { singer: Record<string, unknown> };
	expect(Object.keys(singer).sort()).toEqual([...PUBLIC_SINGER_KEYS]);
});

test('F2 PATCH /api/me returns the wire shape — no roomId, no sessionToken', async () => {
	const db = migratedDb();
	const { room, singers } = installApp(db);
	const created = singers.create('Maya', '#ff5cae', 1_700_000_000_000, room.id);

	const res = await patch({ displayName: 'Maya B' }, created.sessionToken);
	expect(res.status).toBe(200);
	const { singer } = (await res.json()) as { singer: Record<string, unknown> };
	expect(singer.displayName).toBe('Maya B'); // the rename really happened
	expect(Object.keys(singer).sort()).toEqual([...PUBLIC_SINGER_KEYS]);
});

test('F2 the broadcast singer:updated frame matches PublicSinger', async () => {
	// The frame is the reason this is guarded rather than only corrected in prose: it goes to every
	// device in the room, its declared type has no room field, and nothing in the compiler was ever
	// going to notice the widening.
	const db = migratedDb();
	const { room, singers, published } = installApp(db);
	const created = singers.create('Maya', '#ff5cae', 1_700_000_000_000, room.id);

	const res = await patch({ color: '#00aaff' }, created.sessionToken);
	expect(res.status).toBe(200);

	const frames = published.filter((e) => e.type === 'singer:updated');
	expect(frames.length).toBe(1); // it really broadcast — an empty filter would pass the loop below
	const frame = frames[0] as { singer: Record<string, unknown> };
	expect(Object.keys(frame.singer)).not.toContain('roomId');
	expect(Object.keys(frame.singer).sort()).toEqual([...PUBLIC_SINGER_KEYS]);
});
