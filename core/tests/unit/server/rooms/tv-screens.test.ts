import { expect, it } from 'bun:test';
import { read } from '$test';
import { MAX_TV_SCREENS } from '$lib/contract';
import { DRIFT_FRESH_MS, NEW_SCREEN_MS, TvScreens, cleanScreenName } from '$lib/server/rooms/tv-screens';

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
	expect(s.list(R, 2).map((v) => [v.name, v.isTv, v.canBeTv])).toEqual([
		['Screen 2', true, true],
		['Screen 1', false, true],
		['Screen 3', false, false]
	]);
});

it('a screen with two tabs is one row, and a reload keeps its number and name', () => {
	const c = clock();
	const s = new TvScreens(c.now);
	s.connect(R, 1, 'tvA');
	s.connect(R, 2, 'tvA');
	expect(s.list(R, null)).toHaveLength(1);
	expect(s.rename(R, 'tvA', 'Kitchen')).toBe(true);
	s.disconnect(R, 1);
	s.disconnect(R, 2);
	s.connect(R, 3, 'tvA');
	expect(s.list(R, null)[0]).toMatchObject({ id: 'tvA', name: 'Kitchen', isNew: false });
});

it('a removed screen forgets its name and comes back as a new one', () => {
	const c = clock();
	const s = new TvScreens(c.now);
	s.connect(R, 1, 'tvA');
	s.rename(R, 'tvA', 'Kitchen');
	s.forget(R, 'tvA');
	s.disconnect(R, 1);
	s.connect(R, 2, 'tvA');
	expect(s.list(R, null)[0]).toMatchObject({ name: 'Screen 2', isNew: true });
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
	expect(s.list(R, 1).map((v) => v.isNew)).toEqual([false, true]);
	s.rename(R, 'tvB', 'Hall');
	expect(s.list(R, 1)[1]!.isNew).toBe(false);
	s.connect(R, 3, 'tvC');
	c.t += NEW_SCREEN_MS;
	expect(s.list(R, 1)[2]!.isNew).toBe(false);
});

it('drift is a copy-only, finite, fresh report', () => {
	const c = clock();
	const s = new TvScreens(c.now);
	s.connect(R, 1, 'tv');
	s.connect(R, 2, 'copy');
	s.drift(R, 1, 30);
	s.drift(R, 2, -12.4);
	expect(s.list(R, 1).map((v) => v.driftMs)).toEqual([null, -12]);
	for (const bad of [Number.NaN, Infinity, '5', null]) s.drift(R, 2, bad);
	expect(s.list(R, 1)[1]!.driftMs).toBe(-12);
	s.drift(R, 2, 1e9);
	expect(s.list(R, 1)[1]!.driftMs).toBe(60_000);
	c.t += DRIFT_FRESH_MS;
	expect(s.list(R, 1)[1]!.driftMs).toBeNull();
});

it('the room fills at MAX_TV_SCREENS screens, and a screen already open is never "one more"', () => {
	const s = new TvScreens(clock().now);
	for (let i = 0; i < MAX_TV_SCREENS; i++) s.connect(R, i + 1, `tv${i}`);
	expect(s.isFull(R, 'tvNew')).toBe(true);
	expect(s.isFull(R, undefined)).toBe(true);
	expect(s.isFull(R, 'tv3')).toBe(false);
	expect(s.isFull('another room', 'tvNew')).toBe(false);
	s.disconnect(R, 1);
	expect(s.isFull(R, 'tvNew')).toBe(false);
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
	expect(open).toContain('app.rooms.tvSeat(roomId) !== tvId');
	const drift = src.split("case 'tv:drift':")[1]!.split('break;')[0]!;
	expect(drift).toContain('!seated(ws)');
	expect(src).toContain('if (ws.data.refused) return;');
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
