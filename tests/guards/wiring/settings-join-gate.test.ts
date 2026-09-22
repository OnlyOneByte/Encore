// Q2-A retired `/join`, so the settings-behind-join gate now redirects an UNJOINED visitor to the
// landing page `/` (which hosts the join UI), carrying `?next=` so `safeNextPath` at `/` returns them
// to the tab they asked for after joining. Before this the redirect targeted `/join?next=`, and the
// open-redirect guard lived on `/join`; the whole point of Q2-A is that both move to `/`.
//
// Drives the REAL `load` with an unjoined session (no cookie → no singer) and reads the thrown
// SvelteKit redirect. A revert to `/join?next=` reds here.
import { test, expect, afterEach } from 'bun:test';
// The route module under test. There is no alias for `routes/`, so this is a correct repo-relative
// path from tests/guards/wiring/ rather than the old `./+page.server`. It fails LOUDLY with
// `Cannot find module` if the depth is wrong.
import { load } from '$routes/settings/+page.server';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SingerRepository } from '$lib/server/singers/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { migratedDb } from '$lib/server/db/test-db';
import { read } from '@encore/test-support';

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

test('leaving the room sends the guest to / (the landing page), not the retired /join', () => {
	// The leave handler clears the session cookie and navigates; after Q2-A the honest destination
	// is `/` (which shows the join UI unjoined), never `/join`. Source-scan: mounting the settings page
	// needs its full load data, so the navigation target is pinned from the source. A revert reds here.
	// A SIBLING READ, re-anchored explicitly: `at('src/routes/settings/+page.svelte')` meant the settings
	// route's own page — the one whose leave handler navigates — and every route directory has a
	// `+page.svelte`, so the subject has to be named. `read` throws if it is gone, which keeps the two
	// assertions below from passing over an empty string.
	const page = read('src/routes/settings/+page.svelte')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\/\*[\s\S]*?\*\//g, ' ');
	expect(page).toMatch(/await goto\(\s*['"`]\/['"`]\s*\)/);
	expect(page).not.toMatch(/goto\(\s*['"`]\/join/);
});
