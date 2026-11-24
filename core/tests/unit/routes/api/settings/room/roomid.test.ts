// PUT /api/settings/room must ADDRESS the room named by `?roomId=`, never always the default. The
// repository is keyed by an explicit roomId, so calling setRoom/getEffective with NO id lands every write
// on the literal room 'main' whatever it meant. Driven through the REAL PUT handler against a REAL
// SettingsRepository, so the pinned mechanism is end-to-end: the query param reaches the repository call,
// and reverting EITHER threaded argument reds this file.
import { test, expect, afterEach } from 'bun:test';
import { PUT } from '$routes/api/settings/room/+server';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { migratedDb } from '$lib/server/db/test-db';
import { DEFAULT_ROOM_SETTINGS } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');

/** Minimal app exposing only what the room PUT handler reads via getApp(), backed by a real repo. */
function installApp(settings: SettingsRepository, activeRoomId = 'active-room') {
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		// The host: can(actor,'settings:write-room') passes iff the host session is live.
		hostKey: { isHost: () => true },
		now: () => 0,
		settings,
		// An omitted ?roomId= falls back to the LIVE room, not the literal 'main'.
		activeRoomId,
		publish: () => {},
		// reorder() returning null skips the queue:patch branch, which is irrelevant here.
		state: { reorder: () => null },
		mediaById: new Map()
	};
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function putRoom(roomId: string | null, body: unknown) {
	const qs = roomId === null ? '' : `?roomId=${encodeURIComponent(roomId)}`;
	const url = new URL(`http://x/api/settings/room${qs}`);
	const request = new Request(url, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return PUT({ request, cookies: { get: () => 'ignored' }, url } as never);
}

test('a non-default roomId writes THAT room, leaving the default room untouched', async () => {
	const settings = new SettingsRepository(migratedDb());
	installApp(settings);
	expect(DEFAULT_ROOM_SETTINGS.songIntroMs).toBe(2500); // guards the sentinel below stays non-default

	const res = await putRoom('partyB', { songIntroMs: 5000 });
	expect(res.status).toBe(200);

	expect(settings.getRoom('partyB').songIntroMs).toBe(5000);
	// …and the default room did NOT absorb it.
	expect(settings.getRoom('main').songIntroMs).toBe(2500);
});

test('the response body reflects the ADDRESSED room, not the default room', async () => {
	const settings = new SettingsRepository(migratedDb());
	installApp(settings);
	const res = await putRoom('partyB', { songIntroMs: 5000 });
	// getEffective(roomId) must read back the named room, not the default's 2500.
	const payload = (await res.json()) as { room: { songIntroMs: number } };
	expect(payload.room.songIntroMs).toBe(5000);
});

test('an absent roomId writes the ACTIVE room, not the literal "main"', async () => {
	// The phone settings page fetches /api/settings/room with NO ?roomId=, so a bare write that lands on
	// 'main' while every reader reads the ACTIVE room is silently discarded — the host toggles a control,
	// gets 200, and nothing changes. The fallback is app.activeRoomId, where the readers look.
	const active = 'active-room';
	const settings = new SettingsRepository(migratedDb());
	installApp(settings, active);
	const res = await putRoom(null, { songIntroMs: 5000 });
	expect(res.status).toBe(200);
	expect(settings.getRoom(active).songIntroMs).toBe(5000);
	// …and did NOT land on 'main', which is what discards it.
	expect(settings.getRoom('main').songIntroMs).toBe(2500);
});
