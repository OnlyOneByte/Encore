import { expect, it } from 'bun:test';
import { read } from '$test';
import {
	DRIFT_FRESH_MS,
	MAX_COOKIELESS_SCREENS,
	NEW_SCREEN_MS,
	REMEMBER_MAX,
	REMEMBER_MS,
	TvScreens,
	cleanScreenName
} from '$lib/server/rooms/tv-screens';

const R = 'room';
const clock = () => {
	const c = { t: 1_000_000, now: () => c.t };
	return c;
};

it('numbers screens in the order they first open, and lists the TV first', () => {
	const c = clock();
	const s = new TvScreens(c.now);
	s.connect(R, 1, 'tvA');
	s.connect(R, 2, 'tvB');
	s.connect(R, 3, undefined);
	expect(s.list(R, 2, 'tvB').map((v) => [v.name, v.isTv, v.canBeTv, v.canRemove])).toEqual([
		['Screen 2', true, true, false],
		['Screen 1', false, true, true],
		['Screen 3', false, false, true]
	]);
	// A screen standing in for the room's TV holds the seat and can still be removed.
	expect(s.list(R, 1, 'tvB').map((v) => [v.name, v.isTv, v.canRemove])).toEqual([
		['Screen 1', true, true],
		['Screen 2', false, false],
		['Screen 3', false, true]
	]);
});

it('a screen with two tabs is one row, and a reload keeps its number and name', () => {
	const c = clock();
	const s = new TvScreens(c.now);
	s.connect(R, 1, 'tvA');
	s.connect(R, 2, 'tvA');
	expect(s.list(R, null, null)).toHaveLength(1);
	expect(s.rename(R, 'tvA', 'Kitchen')).toBe(true);
	s.disconnect(R, 1);
	s.disconnect(R, 2);
	s.connect(R, 3, 'tvA');
	expect(s.list(R, null, null)[0]).toMatchObject({ id: 'tvA', name: 'Kitchen', isNew: false });
});

it('a removed screen forgets its name and comes back as a new one', () => {
	const c = clock();
	const s = new TvScreens(c.now);
	s.connect(R, 1, 'tvA');
	s.rename(R, 'tvA', 'Kitchen');
	s.forget(R, 'tvA');
	s.disconnect(R, 1);
	s.connect(R, 2, 'tvA');
	expect(s.list(R, null, null)[0]).toMatchObject({ name: 'Screen 1', isNew: true });
});

it('only an open screen can be renamed', () => {
	const s = new TvScreens(clock().now);
	expect(s.rename(R, 'nobody', 'Kitchen')).toBe(false);
});

it('a new screen is the arrival for a minute, until it is named', () => {
	const c = clock();
	const s = new TvScreens(c.now);
	s.connect(R, 1, 'tvA');
	s.connect(R, 2, 'tvB');
	expect(s.list(R, 1, 'tv').map((v) => v.isNew)).toEqual([false, true]);
	s.rename(R, 'tvB', 'Hall');
	expect(s.list(R, 1, 'tv')[1]!.isNew).toBe(false);
	s.connect(R, 3, 'tvC');
	c.t += NEW_SCREEN_MS;
	expect(s.list(R, 1, 'tv')[2]!.isNew).toBe(false);
});

it('drift is a copy-only, finite, fresh report', () => {
	const c = clock();
	const s = new TvScreens(c.now);
	s.connect(R, 1, 'tv');
	s.connect(R, 2, 'copy');
	s.drift(R, 1, 30);
	s.drift(R, 2, -12.4);
	expect(s.list(R, 1, 'tv').map((v) => v.driftMs)).toEqual([null, -12]);
	for (const bad of [Number.NaN, Infinity, '5', null]) s.drift(R, 2, bad);
	expect(s.list(R, 1, 'tv')[1]!.driftMs).toBe(-12);
	s.drift(R, 2, 1e9);
	expect(s.list(R, 1, 'tv')[1]!.driftMs).toBe(60_000);
	c.t += DRIFT_FRESH_MS;
	expect(s.list(R, 1, 'tv')[1]!.driftMs).toBeNull();
});

// The review of #1204: a script minting cookies filled a cookied cap, and the room's own TV was refused. A cookie is
// free to mint, so only cookieless sockets, which can never hold the seat, are capped.
it('only cookieless sockets are capped; a screen with a cookie is never turned away', () => {
	const s = new TvScreens(clock().now);
	expect(s.isFull(R, undefined)).toBe(false);
	for (let i = 0; i < MAX_COOKIELESS_SCREENS; i++) s.connect(R, i + 1, undefined);
	expect(s.isFull(R, undefined)).toBe(true);
	for (let i = 0; i < 100; i++) s.connect(R, 100 + i, `minted${i}`);
	expect(s.isFull(R, 'theTv')).toBe(false);
	expect(s.isFull('another room', undefined)).toBe(false);
	s.disconnect(R, 1);
	expect(s.isFull(R, undefined)).toBe(false);
});

it('closed screens are remembered for a day and at most REMEMBER_MAX of them; numbers stay small', () => {
	const c = clock();
	const s = new TvScreens(c.now);
	s.connect(R, 1, 'kitchen');
	s.rename(R, 'kitchen', 'Kitchen');
	s.disconnect(R, 1);
	// Cookies minted by a script: each is closed at once, and none grows the numbers past the cap.
	for (let i = 0; i < REMEMBER_MAX + 50; i++) {
		s.connect(R, 10 + i, `minted${i}`);
		s.disconnect(R, 10 + i);
	}
	s.connect(R, 9999, 'fresh');
	const n = Number(s.list(R, null, null)[0]!.name.replace('Screen ', ''));
	expect(n).toBeLessThanOrEqual(REMEMBER_MAX + 1);
	s.disconnect(R, 9999);
	// The oldest, Kitchen, was the first to go.
	s.connect(R, 2, 'kitchen');
	expect(s.list(R, null, null)[0]!.name).not.toBe('Kitchen');
	s.disconnect(R, 2);
	// A name within the day survives; past it, it is gone.
	const t = new TvScreens(c.now);
	t.connect(R, 1, 'hall');
	t.rename(R, 'hall', 'Hall');
	t.disconnect(R, 1);
	c.t += REMEMBER_MS - 1;
	t.connect(R, 2, 'hall');
	expect(t.list(R, null, null)[0]!.name).toBe('Hall');
	t.disconnect(R, 2);
	c.t += REMEMBER_MS + 1;
	t.connect(R, 3, 'other');
	t.connect(R, 4, 'hall');
	expect(t.list(R, null, null).map((v) => v.name)).toEqual(['Screen 1', 'Screen 2']);
});

it('cleanScreenName trims, folds space, drops control characters and caps the length', () => {
	expect(cleanScreenName('  Living \n room  TV ')).toBe('Living room TV');
	expect(cleanScreenName('a\u0000b\u007f')).toBe('ab');
	expect(cleanScreenName('x'.repeat(40))).toHaveLength(32);
	for (const bad of ['', '   ', '\u0001', 42, null, undefined]) expect(cleanScreenName(bad)).toBeNull();
});

// The host-only surface and the socket side, pinned where they are wired.
it('server.ts turns a screen too many away at open and takes drift from copies only', () => {
	const src = read('server.ts');
	const open = src.split('open(ws) {')[1]!.split('message(ws, raw)')[0]!;
	expect(open.indexOf('tvScreens.isFull(')).toBeLessThan(open.indexOf('ws.subscribe('));
	expect(open).toContain('tvScreens.isFull(roomId, tvId)');
	const drift = src.split("case 'tv:drift':")[1]!.split('break;')[0]!;
	expect(drift).toContain('!seated(ws)');
	expect(src).toContain('if (ws.data.refused) return;');
	// Remove refuses only the room's TV, and hands the seat of a screen standing in for it back before it closes.
	const remove = src.split('remove: (id) => {')[1]!.split("return 'ok';")[0]!;
	expect(remove).toContain("if (id === tvSeats.roomTv(app.activeRoomId)) return 'is-tv';");
	expect(remove.indexOf('tvSeats.release(')).toBeLessThan(remove.indexOf('.close(TV_REMOVED_CLOSE_CODE'));
});

it('/api/screens is host only, and a mid-song "make this the TV" is refused', () => {
	const route = read('src/routes/api/screens/+server.ts');
	expect(route.match(/can\(\{ host: isHost\(cookies\) \}, 'screens:manage'\)/g)?.length).toBe(2);
	expect(read('src/lib/server/capabilities.ts')).toMatch(/HOST_ONLY[\s\S]*'screens:manage'/);
	const server = read('server.ts');
	expect(server.split('makeTv: (id) => {')[1]!.split('}')[0]).toContain(
		"if (app.screens!.midSong()) return 'mid-song';"
	);
});
