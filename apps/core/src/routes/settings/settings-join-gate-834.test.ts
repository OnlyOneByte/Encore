// Q2-A retired `/join`, so the settings-behind-join gate now redirects an UNJOINED visitor to the
// landing page `/` (which hosts the join UI), carrying `?next=` so `safeNextPath` at `/` returns them
// to the tab they asked for after joining. Before this the redirect targeted `/join?next=`, and the
// open-redirect guard lived on `/join`; the whole point of Q2-A is that both move to `/`.
//
// Drives the REAL `load` with an unjoined session (no cookie → no singer) and reads the thrown
// SvelteKit redirect. A revert to `/join?next=` reds here.
import { test, expect, afterEach } from 'bun:test';
import { load } from './+page.server';
import { RoomRepository } from '$server/rooms/repository';
import { SingerRepository } from '$server/singers/repository';
import { SettingsRepository } from '$server/state/settings-repository';
import { migratedDb } from '$server/db/test-db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_KEY = Symbol.for('encore.app');

function installApp() {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const room = rooms.ensureActive(1);
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		db,
		rooms,
		activeRoomId: room.id,
		singers: new SingerRepository(db),
		settings: new SettingsRepository(db)
	};
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

test('an unjoined visitor to /settings is redirected to / (not /join), carrying ?next=', async () => {
	installApp();
	const url = new URL('http://x/settings?tab=you');
	const request = new Request(url);
	// No session cookie → no singer → the gate redirects. SvelteKit's redirect() throws.
	let thrown: unknown;
	try {
		await load({ cookies: { get: () => undefined }, request, url } as never);
	} catch (e) {
		thrown = e;
	}
	const redir = thrown as { status?: number; location?: string };
	expect(redir.status).toBe(303);
	// The destination is the landing page, and it is NOT the retired /join.
	expect(redir.location).toBe(`/?next=${encodeURIComponent('/settings?tab=you')}`);
	expect(redir.location).not.toContain('/join');
});

test("leaving the room sends the guest to / (the landing page), not the retired /join", () => {
	// The leave handler clears the session cookie and navigates; after #834 Q2-A the honest destination
	// is `/` (which shows the join UI unjoined), never `/join`. Source-scan: mounting the settings page
	// needs its full load data, so the navigation target is pinned from the source. A revert reds here.
	const page = readFileSync(join(import.meta.dir, '+page.svelte'), 'utf8')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\/\*[\s\S]*?\*\//g, ' ');
	expect(page).toMatch(/await goto\(\s*['"`]\/['"`]\s*\)/);
	expect(page).not.toMatch(/goto\(\s*['"`]\/join/);
});
