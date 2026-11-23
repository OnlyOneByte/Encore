// POST /api/leave ends the session on the SERVER (proposal 20). It used to clear only the asking tab's cookie: the token
// still resolved, so a copy of the cookie (another tab's reconnect, a replayed request) came back as the guest who left,
// and that singer's other sockets kept acting as them. Drives the REAL handler, as me-color does.
import { test, expect, afterEach } from 'bun:test';
import { POST } from '$routes/api/leave/+server';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SingerRepository } from '$lib/server/singers/repository';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { AuthoritativeState } from '$lib/server/state/store';
import { migratedDb } from '$lib/server/db/test-db';
import type { ServerEvent } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');
const NOW = 1_700_000_000_000;

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function room() {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const active = rooms.ensureActive(1);
	const singers = new SingerRepository(db);
	const released: string[] = [];
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		db,
		rooms,
		activeRoomId: active.id,
		singers,
		presence: new PresenceTracker(),
		state: new AuthoritativeState(),
		now: () => NOW,
		publish: (_e: ServerEvent) => {},
		releaseSinger: (id: string) => released.push(id)
	};
	const maya = singers.create('Maya', '#a78bfa', NOW, active.id);
	const theo = singers.create('Theo', '#ff5cae', NOW, active.id);
	return { singers, maya, theo, released };
}

const leave = (token: string) =>
	POST({ cookies: { get: () => token, set: () => {}, delete: () => {} } } as never) as Promise<Response>;

test("a leave ends the token and releases that singer's sockets", async () => {
	const { singers, maya, theo, released } = room();
	expect((await leave(maya.sessionToken)).status).toBe(200);
	expect(singers.bySessionToken(maya.sessionToken), 'the old cookie still resolves to the guest who left').toBeNull();
	expect(released).toEqual([maya.id]);
	// Only theirs: another guest's session is untouched.
	expect(singers.bySessionToken(theo.sessionToken)?.id).toBe(theo.id);
});

test('the same cookie cannot leave twice', async () => {
	const { maya, released } = room();
	await leave(maya.sessionToken);
	expect((await leave(maya.sessionToken)).status).toBe(401);
	expect(released).toEqual([maya.id]);
});
