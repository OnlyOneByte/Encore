// PATCH /api/me resolves a colour the way a join does: an unusable one gets the free stop farthest from the room's
// held colours, never the first preset, which could be someone else's. Drives the REAL handler, as me-room-strip does.
import { test, expect, afterEach } from 'bun:test';
import { PATCH } from '$routes/api/me/+server';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SingerRepository } from '$lib/server/singers/repository';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { AuthoritativeState } from '$lib/server/state/store';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { migratedDb } from '$lib/server/db/test-db';
import { SINGER_COLORS, freeSingerColor, nearestPaletteStop, type ServerEvent } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');
const NOW = 1_700_000_000_000;

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

/** Maya holds the first preset's stop and Sam holds pink; both are connected, so both are in the room. */
function room() {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const active = rooms.ensureActive(1);
	const singers = new SingerRepository(db);
	const presence = new PresenceTracker();
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		db,
		rooms,
		activeRoomId: active.id,
		singers,
		presence,
		state: new AuthoritativeState(),
		settings: new SettingsRepository(db),
		now: () => NOW,
		publish: (_e: ServerEvent) => {}
	};
	const maya = singers.create('Maya', nearestPaletteStop(SINGER_COLORS[0]).fill, NOW, active.id);
	const sam = singers.create('Sam', '#ff5cae', NOW, active.id);
	presence.connect(maya.id);
	presence.connect(sam.id);
	return { maya, sam };
}

async function patchColor(token: string, color: string): Promise<string> {
	const url = new URL('http://x/api/me');
	const request = new Request(url, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', host: 'x' },
		body: JSON.stringify({ color })
	});
	const res = await PATCH({ request, cookies: { get: () => token, set: () => {}, delete: () => {} }, url } as never);
	expect(res.status).toBe(200);
	return ((await res.json()) as { singer: { color: string } }).singer.color;
}

for (const bad of ['#nonsense', '#000000']) {
	test(`an unusable colour on a profile edit (${bad}) gets the room's free pick, not the first preset`, async () => {
		const { maya, sam } = room();
		const got = await patchColor(sam.sessionToken, bad);
		// Sam's own pink is not "held" against him: only Maya's colour is.
		expect(got).toBe(freeSingerColor([maya.color]));
		expect(nearestPaletteStop(got).i).not.toBe(nearestPaletteStop(maya.color).i);
	});
}

test('a legible colour on a profile edit is kept as asked, even one someone holds', async () => {
	const { maya, sam } = room();
	expect(await patchColor(sam.sessionToken, maya.color)).toBe(maya.color);
});
