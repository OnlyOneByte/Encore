// PUT /api/settings/room must ADDRESS the room named by `?roomId=`, not always the default room.
//
// The repository (SettingsRepository.setRoom/getRoom/getEffective) has always been keyed by an
// explicit roomId; the bug (#653) was that this endpoint called setRoom(body)/getEffective() with
// NO id, so every write — whatever room it meant — landed on DEFAULT_ROOM_ID ('main'). These tests
// drive the REAL PUT handler against a REAL SettingsRepository on an in-memory migrated DB, so the
// pinned mechanism is end-to-end: the query param reaches the repository call.
//
// MUTATION / BASE-RED: on base, `?roomId=partyB` writes 'main' instead, so getRoom('partyB') reads
// back the DEFAULT (2500) and getRoom('main') becomes 5000 — both assertions below invert. Reverting
// EITHER threaded argument (setRoom's roomId or getEffective's) reds this file.
import { test, expect, afterEach } from 'bun:test';
import { PUT } from './+server';
import { SettingsRepository, DEFAULT_ROOM_ID } from '$server/state/settings-repository';
import { migratedDb } from '$server/db/test-db';
import { DEFAULT_ROOM_SETTINGS } from '@encore/shared';

const APP_KEY = Symbol.for('encore.app');

/** Minimal app exposing only what the room PUT handler reads via getApp(), backed by a real repo. */
function installApp(settings: SettingsRepository) {
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		// A joined singer: can(actor,'settings:write-room') passes iff singerId is truthy.
		singers: { bySessionToken: () => ({ id: 'singer-1' }) },
		settings,
		publish: () => {},
		// reorder() returning null skips the queue:patch branch — irrelevant to room addressability.
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
	// cookies.get is read only to resolve the singer, which the fake bySessionToken ignores.
	return PUT({ request, cookies: { get: () => 'ignored' }, url } as never);
}

test('a non-default roomId writes THAT room, leaving the default room untouched', async () => {
	const settings = new SettingsRepository(migratedDb());
	installApp(settings);
	expect(DEFAULT_ROOM_SETTINGS.songIntroMs).toBe(2500); // guards the sentinel below stays non-default

	const res = await putRoom('partyB', { songIntroMs: 5000 });
	expect(res.status).toBe(200);

	// The named room received the write…
	expect(settings.getRoom('partyB').songIntroMs).toBe(5000);
	// …and the default room did NOT (on base, the default room absorbs every write instead).
	expect(settings.getRoom(DEFAULT_ROOM_ID).songIntroMs).toBe(2500);
});

test('the response body reflects the ADDRESSED room, not the default room', async () => {
	const settings = new SettingsRepository(migratedDb());
	installApp(settings);
	const res = await putRoom('partyB', { songIntroMs: 5000 });
	// getEffective(roomId) must read back partyB; on base it reads 'main' and returns 2500.
	const payload = (await res.json()) as { room: { songIntroMs: number } };
	expect(payload.room.songIntroMs).toBe(5000);
});

test('an absent roomId still writes the default room (existing callers unchanged)', async () => {
	const settings = new SettingsRepository(migratedDb());
	installApp(settings);
	const res = await putRoom(null, { songIntroMs: 5000 });
	expect(res.status).toBe(200);
	expect(settings.getRoom(DEFAULT_ROOM_ID).songIntroMs).toBe(5000);
});
