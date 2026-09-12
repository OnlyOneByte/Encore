// one-TV-per-room, at the TV loader: the TV route RESOLVES which room it shows. A bare /tv shows
// the served room (covered by join-qr-room-code.test.ts); an explicit ?room=<code> shows THAT room,
// and its code is what the client then binds the WS to. Unknown code falls back to the served room.
//
// BASE-RED: on origin/main the loader ignores ?room entirely — roomCode is always the activeRoom code
// and there is no roomCode in the returned data at all — so a TV cannot be pointed at another party.
import { test, expect, afterEach } from 'bun:test';
import { load } from '../../../../../src/routes/tv/+page.server';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { migratedDb } from '$lib/server/db/test-db';

const APP_KEY = Symbol.for('encore.app');
afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function installApp(db: ReturnType<typeof migratedDb>, activeRoomId: string, rooms: RoomRepository) {
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		rooms,
		activeRoomId,
		settings: new SettingsRepository(db)
	};
}
async function loadRoomCode(u: string): Promise<string> {
	const url = new URL(u);
	const request = new Request(url, { headers: { host: 'tv.lan:3000' } });
	const data = (await load({ url, request } as never)) as { roomCode: string };
	return data.roomCode;
}

test('a bare /tv resolves the SERVED room code (pre-room-identity behaviour preserved)', async () => {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const served = rooms.ensureActive(1);
	const other = rooms.create(2);
	installApp(db, served.id, rooms);
	expect(await loadRoomCode('http://tv.lan:3000/tv')).toBe(served.code);
	expect(other.code).not.toBe(served.code); // two real distinct rooms exist
});

test('an explicit ?room=<code> resolves THAT room, so the TV shows a specific party', async () => {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const served = rooms.ensureActive(1);
	const other = rooms.create(2);
	installApp(db, served.id, rooms);
	// Pointed at the OTHER room by its code, the loader resolves that room, not the served one.
	expect(await loadRoomCode(`http://tv.lan:3000/tv?room=${other.code}`)).toBe(other.code);
});

test('an unknown ?room code falls back to the served room rather than a code-less TV', async () => {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const served = rooms.ensureActive(1);
	installApp(db, served.id, rooms);
	expect(await loadRoomCode('http://tv.lan:3000/tv?room=NOSUCH')).toBe(served.code);
});
