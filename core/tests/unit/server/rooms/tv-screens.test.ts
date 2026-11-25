import { expect, it } from 'bun:test';
import { read } from '$test';
import {
	DRIFT_FRESH_MS,
	MAX_COOKIELESS_SCREENS,
	NEW_SCREEN_MS,
	REMEMBER_MAX,
	REMEMBER_MS,
	TvScreens,
	cleanScreenName,
	parseTvShow
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
	// The seat knows a song is on, and every broadcast that moves the current song is a boundary for it.
	expect(src).toContain('midSong: () => state.playback.currentEntryId !== null');
	const pub = src.split('const broadcast = (e: ServerEvent) => {')[1]!.split('};')[0]!;
	expect(pub).toContain('announceSeat(tvSeats.boundary(app.activeRoomId));');
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

// #1249: only the host's choice names the room's TV. Pinned at the two claim sites and the one place the cookie is read.
it('the Screens page claims as the host; a tap on a /tv claims as the host only with a live host session', () => {
	const server = read('server.ts');
	expect(server.split('makeTv: (id) => {')[1]!.split("return 'ok';")[0]).toContain(
		'tvSeats.claim(app.activeRoomId, key, true)'
	);
	const tap = server.split("case 'tv:claim':")[1]!.split('break;')[0]!;
	expect(tap).toContain('const byHost = app.hostKey.isHost(ws.data.hostToken, app.now());');
	expect(tap).toContain('tvSeats.claim(ws.data.roomId!, ws.data.tvKey, byHost)');
	expect(server).toContain("const hostToken = role === 'tv' ? readHostToken(req.headers.get('cookie')) : undefined;");
	expect(server.match(/tvSeats\.claim\(/g)?.length).toBe(2);
});

// Proposal 34, PR 4: Words only.
it('a screen shows everything until set; a ?show= seeds only a screen with no layout yet', () => {
	const s = new TvScreens(clock().now);
	s.connect(R, 1, 'tvA');
	expect(s.show(R, 'tvA')).toBe('everything');
	s.connect(R, 2, 'tvB', 'words');
	expect(s.show(R, 'tvB')).toBe('words');
	// The host's later choice outlives a reload of the bookmarked URL.
	expect(s.setShow(R, 'tvB', 'everything')).toBe(true);
	s.disconnect(R, 2);
	s.connect(R, 3, 'tvB', 'words');
	expect(s.show(R, 'tvB')).toBe('everything');
	expect(s.list(R, 1, 'tvA').map((v) => [v.id, v.show])).toEqual([
		['tvA', 'everything'],
		['tvB', 'everything']
	]);
});

it('only an open screen takes a layout, and a removed screen forgets it', () => {
	const s = new TvScreens(clock().now);
	expect(s.setShow(R, 'nobody', 'words')).toBe(false);
	s.connect(R, 1, 'tvA');
	s.setShow(R, 'tvA', 'words');
	s.forget(R, 'tvA');
	expect(s.show(R, 'tvA')).toBe('everything');
	expect(s.screenOf(R, 1)).toBe('tvA');
	expect(s.screenOf(R, 99)).toBeUndefined();
});

it('parseTvShow takes the three layouts and nothing else', () => {
	expect(parseTvShow('everything')).toBe('everything');
	expect(parseTvShow('words')).toBe('words');
	expect(parseTvShow('board')).toBe('board');
	for (const bad of ['lyrics', 'Words', 'BOARD', '', null, undefined, 1, {}]) expect(parseTvShow(bad)).toBeNull();
});

it('server.ts tells a screen its layout, keeps the TV on everything, and the API takes only a valid layout', () => {
	const server = read('server.ts');
	// A screen that takes the seat shows the whole stage, from every seat move.
	const seat = server.split('function announceSeat(')[1]!.split('\n}')[0]!;
	expect(seat).toContain('if (ws && n.mine) showEverythingOnSeat(ws.data.roomId!, n.key);');
	// The host cannot set the seat's screen to words only.
	const set = server.split('setShow: (id, show) => {')[1]!.split("return 'ok';")[0]!;
	expect(set).toContain("if (keys.includes(tvSeats.holderKey(app.activeRoomId) ?? -1)) return 'is-tv';");
	// The URL's layout is parsed, never passed through, and every connect is told its layout.
	expect(server).toContain("const show = role === 'tv' ? parseTvShow(url.searchParams.get('show')) : null;");
	const open = server.split('open(ws) {')[1]!.split('message(ws, raw)')[0]!;
	expect(open).toContain('tvScreens.connect(ws.data.roomId, ws.data.tvKey, ws.data.tvId, ws.data.show);');
	expect(open).toContain("type: 'tv:show'");
	const route = read('src/routes/api/screens/+server.ts');
	const show = route.split("case 'show': {")[1]!.split('default:')[0]!;
	expect(show).toContain('const show = parseTvShow(body.show);');
	expect(show).toContain('if (!show) return json(');
	expect(show).toContain('{ status: 400 }');
});
