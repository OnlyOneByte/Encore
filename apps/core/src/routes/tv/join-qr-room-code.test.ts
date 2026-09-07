// The TV attract QR must encode THIS room's join code (`/join?room=CODE`), so a scan lands the
// phone in this party rather than at a bare /join (#654). Drives the REAL `load` with a real
// RoomRepository behind the app singleton.
//
// BASE-RED: on origin/main the join URL is always a bare `${origin}/join` with no room code.
import { test, expect, afterEach } from 'bun:test';
import { load } from './+page.server';
import { RoomRepository } from '$server/rooms/repository';
import { SettingsRepository } from '$server/state/settings-repository';
import { migratedDb } from '$server/db/test-db';

const APP_KEY = Symbol.for('encore.app');

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

test("the join URL (and thus the QR) carries the active room's code", async () => {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const active = rooms.ensureActive(1);
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		rooms,
		activeRoomId: active.id,
		settings: new SettingsRepository(db)
	};

	const url = new URL('http://tv.lan:3000/tv');
	const request = new Request(url, { headers: { host: 'tv.lan:3000' } });
	const data = (await load({ url, request } as never)) as { joinUrl: string };
	expect(data.joinUrl).toContain(`?room=${active.code}`);
});
