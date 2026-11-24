// The settings-behind-join gate redirects an UNJOINED visitor to the landing page `/`, which hosts the
// join UI, carrying `?next=` so `safeNextPath` returns them to the tab they asked for after joining. `/join`
// is retired, so a redirect there — and the open-redirect guard that used to live on it — must not return.
import { test, expect, afterEach } from 'bun:test';
import { load } from '$routes/settings/+page.server';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SingerRepository } from '$lib/server/singers/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { migratedDb } from '$lib/server/db/test-db';
import { read } from '$test';

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
		settings: new SettingsRepository(db),
		hostKey: { isHost: () => false },
		now: () => 0
	};
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

test('an unjoined visitor to /settings is redirected to / (not /join), carrying ?next=', async () => {
	installApp();
	/* A SCOPE ROUTE AND ITS SEARCH STRING, because that is what the `?next=` has to survive: the gate builds the
	   destination from `url.pathname` + `url.search`, so a guest sent to fix their NAME comes back to the You scope
	   rather than to the room scope the bare `/settings` resolves to. */
	const url = new URL('http://x/settings/you?next=/');
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
	expect(redir.location).toBe(`/?next=${encodeURIComponent('/settings/you?next=/')}`);
	expect(redir.location).not.toContain('/join');
});

test('leaving the room sends the guest to / (the landing page), not the retired /join', () => {
	/* Scanned rather than driven, because mounting the page needs its full load data. `read` throws when the subject
	   is gone, so the two assertions cannot pass over an empty string. The subject is the YOU scope: `leaveRoom` lives
	   with the identity it forgets, and it is the one `goto` on that page that is NOT resolved through `?next=` —
	   the cookie is gone, so `/` is the only honest destination. */
	const page = read('src/routes/settings/you/+page.svelte')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\/\*[\s\S]*?\*\//g, ' ');
	expect(page).toMatch(/await goto\(\s*['"`]\/['"`]\s*\)/);
	expect(page).not.toMatch(/goto\(\s*['"`]\/join/);
});
