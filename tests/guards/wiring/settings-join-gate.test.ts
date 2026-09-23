// The settings-behind-join gate redirects an UNJOINED visitor to the landing page `/`, which hosts the
// join UI, carrying `?next=` so `safeNextPath` returns them to the tab they asked for after joining. `/join`
// is retired, so a redirect there — and the open-redirect guard that used to live on it — must not return.
import { test, expect, afterEach } from 'bun:test';
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
	// No session cookie means no singer, and SvelteKit's `redirect()` THROWS rather than returning.
	let thrown: unknown;
	try {
		await load({ cookies: { get: () => undefined }, request, url } as never);
	} catch (e) {
		thrown = e;
	}
	const redir = thrown as { status?: number; location?: string };
	expect(redir.status).toBe(303);
	expect(redir.location).toBe(`/?next=${encodeURIComponent('/settings?tab=you')}`);
	expect(redir.location).not.toContain('/join');
});

test('leaving the room sends the guest to / (the landing page), not the retired /join', () => {
	// Scanned rather than driven, because mounting the settings page needs its full load data. `read`
	// throws when the subject is gone, so the two assertions cannot pass over an empty string.
	const page = read('src/routes/settings/+page.svelte')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\/\*[\s\S]*?\*\//g, ' ');
	expect(page).toMatch(/await goto\(\s*['"`]\/['"`]\s*\)/);
	expect(page).not.toMatch(/goto\(\s*['"`]\/join/);
});
