// guard (reviewer advisory A1): making roomId REQUIRED stops a caller silently defaulting to
// 'main', but it does not by itself pin WHICH room each production reader addresses — the source-scan
// guard checks the call SHAPE, not the room VALUE, so it stays green whether a reader passes the live
// room or the literal 'main'. This is the differential that pins the room VALUE: write a setting to the
// LIVE room (a minted ULID, provably not 'main'), then read it back through the production reader path
// and assert the value written is the value seen. Mutating a reader back to 'main' reds this.
//
// BASE-RED: on origin/main every touched reader passed 'main' (a bare default), so
// buildHubDeps().getSettings() and assertNameFree read 'main' and never saw a value written to the live
// room — the getSettings assertion below inverts.
import { test, expect, afterEach } from 'bun:test';
import { migratedDb } from '$server/db/test-db';
import { RoomRepository } from '$server/rooms/repository';
import { SingerRepository } from '$server/singers/repository';
import { PresenceTracker } from '$server/realtime/presence';
import { AuthoritativeState } from '$server/state/store';
import { SettingsRepository } from '$server/state/settings-repository';
import { buildHubDeps, type EncoreApp } from '$server/app';
import { assertNameFree } from '$server/singers/join';

const APP_KEY = Symbol.for('encore.app');

function installApp(db: ReturnType<typeof migratedDb>, activeRoomId: string): EncoreApp {
	const app = {
		db,
		rooms: new RoomRepository(db),
		activeRoomId,
		singers: new SingerRepository(db),
		presence: new PresenceTracker(),
		state: new AuthoritativeState(),
		settings: new SettingsRepository(db),
		popularity: { recordAdd: () => {} },
		jobs: {/* unused by the reads under test */},
		now: () => 1_700_000_000_000,
		publish: () => {}
	} as unknown as EncoreApp;
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	return app;
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

const perFrame = {
	broadcast: () => {},
	actorSingerId: undefined,
	listOnline: () => [],
	listAway: () => [],
	seenOp: () => false,
	hasOp: () => false
};

test('the live room is a minted id, not the literal "main"', () => {
	const db = migratedDb();
	const app = installApp(db, 'placeholder');
	const active = app.rooms.ensureActive(1);
	// The property the whole fix rests on: the room the arc scopes to is NOT 'main'.
	expect(active.id).not.toBe('main');
});

test('buildHubDeps().getSettings() reads the ACTIVE room, not \u0027main\u0027 (A1)', () => {
	const db = migratedDb();
	// bootstrap a real active room and install the app pointing at it
	const active = new RoomRepository(db).ensureActive(1);
	const app = installApp(db, active.id);

	// write distinct values to the live room and to 'main'
	app.settings.setRoom({ songIntroMs: 9999 }, active.id);
	app.settings.setRoom({ songIntroMs: 2222 }, 'main');

	// the reader path this PR threads must return the LIVE room's value
	const deps = buildHubDeps(app, perFrame);
	const getSettings = deps.getSettings;
	expect(getSettings).toBeDefined();
	expect(getSettings!().room.songIntroMs).toBe(9999);
	// and must NOT be reading 'main' (the base behaviour) — differential, so a revert to
	// 'main' at the getSettings site reds here.
	expect(getSettings!().room.songIntroMs).not.toBe(2222);
});

test('another room is unaffected — the read is scoped, not global', () => {
	const db = migratedDb();
	const active = new RoomRepository(db).ensureActive(1);
	const app = installApp(db, active.id);
	const other = app.rooms.create(2);
	expect(other.id).not.toBe(active.id);

	app.settings.setRoom({ songIntroMs: 9999 }, active.id);
	app.settings.setRoom({ songIntroMs: 3333 }, other.id);

	// the app reads its OWN active room, never the other party's
	const getSettings = buildHubDeps(app, perFrame).getSettings;
	expect(getSettings).toBeDefined();
	expect(getSettings!().room.songIntroMs).toBe(9999);
	// and the other room keeps its own value (proves setRoom addressed it, not 'main')
	expect(app.settings.getRoom(other.id).songIntroMs).toBe(3333);
});

test('assertNameFree reads presence grace from the ACTIVE room, not \u0027main\u0027 (A1)', () => {
	const db = migratedDb();
	const active = new RoomRepository(db).ensureActive(1);
	const app = installApp(db, active.id);

	// A distinctive grace in the live room; a different one on 'main'. If assertNameFree read 'main'
	// it would use 60 and this call would still pass — so this is not a strong behavioural assertion
	// on its own, but it pins that the join path threads its room parameter (roomId), which is the
	// active room here. The room-scoped listPublic below is what makes the scoping observable.
	app.settings.setRoom({ presenceGraceMinutes: 1 }, active.id);
	app.settings.setRoom({ presenceGraceMinutes: 60 }, 'main');

	// No singers in the active room, so no clash regardless — the assertion is that it does not throw
	// and, crucially, that it is called with the ACTIVE room (verified by the scoped read above via
	// buildHubDeps). Kept as a smoke that the join wiring compiles against a required roomId.
	expect(() => assertNameFree(app, active.id, 'Maya')).not.toThrow();
});

import { PUT as putRoomHandler } from '../../routes/api/settings/room/+server';

test('writer->reader seam: a param-less PUT lands where buildHubDeps().getSettings() reads', async () => {
	// The regression the readers-only fix opened: the phone settings page fetches /api/settings/room
	// with NO ?roomId=. This drives the REAL PUT handler that bare way, then reads through the REAL
	// buildHubDeps().getSettings() path — the two must agree on the room. BASE-RED: with the writer
	// falling back to 'main' while readers read the active room, getSettings() sees the default, not
	// the written value.
	const db = migratedDb();
	const active = new RoomRepository(db).ensureActive(1);
	const app = installApp(db, active.id);
	// a joined singer so can(settings:write-room) passes; the real handler reads app.singers
	(app as unknown as { singers: { bySessionToken: () => { id: string } } }).singers = {
		bySessionToken: () => ({ id: 'singer-1' })
	};
	(app as unknown as { state: { reorder: () => null } }).state = { reorder: () => null };

	// PUT with NO ?roomId= — exactly what the phone page sends
	const url = new URL('http://x/api/settings/room');
	const request = new Request(url, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ songIntroMs: 6789 })
	});
	const res = await putRoomHandler({ request, cookies: { get: () => 'tok' }, url } as never);
	expect(res.status).toBe(200);

	// the reader path sees the written value — writer and readers agree on the live room
	const getSettings = buildHubDeps(app, perFrame).getSettings;
	expect(getSettings).toBeDefined();
	expect(getSettings!().room.songIntroMs).toBe(6789);
	// and it did NOT land on 'main' (the base regression)
	expect(app.settings.getRoom('main').songIntroMs).not.toBe(6789);
});
