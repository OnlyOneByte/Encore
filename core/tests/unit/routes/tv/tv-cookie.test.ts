// GET /tv names the screen for the room's TV seat: a fresh random `encore_tv` the first time, the SAME value on every
// later load (re-set, so its 30 days restart), and the singer cookie's attributes. See $lib/server/rooms/tv-seat.
import { test, expect, afterEach } from 'bun:test';
import { load } from '$routes/tv/+page.server';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { migratedDb } from '$lib/server/db/test-db';

const APP_KEY = Symbol.for('encore.app');
afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

type Set = { name: string; value: string; opts: Record<string, unknown> };

async function loadTv(cookie?: string): Promise<Set[]> {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const active = rooms.ensureActive(1);
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		rooms,
		activeRoomId: active.id,
		settings: new SettingsRepository(db)
	};
	const url = new URL('http://tv.lan:3000/tv');
	const request = new Request(url, { headers: { host: 'tv.lan:3000', ...(cookie ? { cookie } : {}) } });
	const sets: Set[] = [];
	const cookies = {
		set: (name: string, value: string, opts: Record<string, unknown>) => sets.push({ name, value, opts })
	};
	await load({ url, request, cookies } as never);
	return sets.filter((s) => s.name === 'encore_tv');
}

test('a new screen gets a random, HttpOnly, SameSite=Lax encore_tv for the whole site', async () => {
	const [a] = await loadTv();
	const [b] = await loadTv();
	expect(a!.value).toMatch(/^[A-Za-z0-9_-]{32}$/);
	expect(b!.value).not.toBe(a!.value);
	expect(a!.opts).toMatchObject({
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: false,
		maxAge: 60 * 60 * 24 * 30
	});
});

test('a returning screen keeps its value; a value we could not have minted is replaced', async () => {
	const mine = 'Z'.repeat(32);
	expect((await loadTv(`encore_tv=${mine}`))[0]!.value).toBe(mine);
	expect((await loadTv('encore_tv=forged'))[0]!.value).not.toBe('forged');
});
