// One TV per room: the seat rules, driven with a fake clock and store. The live-socket half (a copy's `ended` and
// position are ignored) is tests/unit/server/ws-socket-guards.test.ts.
import { test, expect } from 'bun:test';
import {
	TvSeats,
	TV_SEAT_GRACE_MS,
	TV_SEAT_SLOW_BOOT_MS,
	readTvCookie,
	tvIdOf,
	type SeatNotice
} from '$lib/server/rooms/tv-seat';

const ROOM = 'room-1';
/** Past the slow-boot window: the TV has been on long enough that only the 15 s grace applies when it goes. */
const ON_A_WHILE = 60_000;

/** `early`: how many ms before its time each timer fires, as Bun's does against Date.now(). */
function world(persisted: string | null = null, early = 0) {
	let now = 1_000_000;
	const saved = new Map<string, string | null>([[ROOM, persisted]]);
	// The fake clock's timers: `advance` only moves time, `tick` also runs every booked sweep that has come due.
	const timers: { at: number; run: () => void }[] = [];
	const announced: SeatNotice[] = [];
	const seats = new TvSeats({
		load: (r) => saved.get(r) ?? null,
		save: (r, h) => saved.set(r, h),
		now: () => now,
		schedule: (ms, run) => timers.push({ at: now + ms - early, run }),
		announce: (n) => announced.push(...n)
	});
	return {
		seats,
		saved,
		timers,
		announced,
		advance: (ms: number) => (now += ms),
		tick: (ms: number) => {
			now += ms;
			for (const t of timers.filter((x) => x.at <= now).sort((x, y) => x.at - y.at)) {
				timers.splice(timers.indexOf(t), 1);
				t.run();
			}
		},
		mine: (key: number) => seats.holds(ROOM, key)
	};
}

test('the first screen takes a free seat; a second is a copy, and each is told', () => {
	const w = world();
	expect(w.seats.connect(ROOM, 1, 'tvA')).toEqual([{ key: 1, mine: true, tvOnline: true }]);
	expect(w.seats.connect(ROOM, 2, 'tvB')).toEqual([{ key: 2, mine: false, tvOnline: true }]);
	expect(w.mine(1)).toBe(true);
	expect(w.mine(2)).toBe(false);
	expect(w.saved.get(ROOM)).toBe('tvA');
});

test('hasLiveHolder: only THE TV counts as connected, never a copy left on its own (proposal 11 fallback)', () => {
	// The held song's fallback starts it only while a TV can play it. A copy's frames are dropped, so it could never
	// report that song failing, and "a TV is connected" must not mean a copy.
	const w = world();
	expect(w.seats.hasLiveHolder(ROOM)).toBe(false);
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'tvB');
	expect(w.seats.hasLiveHolder(ROOM)).toBe(true);
	w.seats.disconnect(ROOM, 1); // the seat's screen goes; only the copy is left, inside the grace
	expect(w.mine(2)).toBe(false);
	expect(w.seats.hasLiveHolder(ROOM)).toBe(false);
	w.seats.claim(ROOM, 2); // the copy is made the TV
	expect(w.seats.hasLiveHolder(ROOM)).toBe(true);
});

test('a socket with no cookie never holds the seat, even a free one, and cannot claim it', () => {
	const w = world();
	expect(w.seats.connect(ROOM, 1, undefined)).toEqual([{ key: 1, mine: false, tvOnline: false }]);
	expect(w.seats.claim(ROOM, 1)).toEqual([]);
	expect(w.mine(1)).toBe(false);
	// The seat stayed free for the real TV.
	w.seats.connect(ROOM, 2, 'tvA');
	expect(w.mine(2)).toBe(true);
});

test('reload: the new socket of the same screen takes over before the old one closes', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'tvB');
	// The new socket is the holder at once; the old one is told it is not.
	expect(w.seats.connect(ROOM, 3, 'tvA')).toEqual([
		{ key: 1, mine: false, tvOnline: true },
		{ key: 3, mine: true, tvOnline: true }
	]);
	// The old socket's late close changes nothing.
	expect(w.seats.disconnect(ROOM, 1)).toEqual([]);
	expect(w.mine(3)).toBe(true);
});

test('reload: the old socket closes first, and the screen is back inside the grace with zero steps', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'tvB');
	// The copy hears the TV is gone, and nothing goes to the socket that closed.
	expect(w.seats.disconnect(ROOM, 1)).toEqual([{ key: 2, mine: false, tvOnline: false }]);
	w.advance(TV_SEAT_GRACE_MS - 1);
	// Not yet: the copy is not promoted while the holder's grace runs.
	expect(w.seats.sweep()).toEqual([]);
	// The TV is back: the copy hears it too (its `mine: false` still goes first).
	expect(w.seats.connect(ROOM, 3, 'tvA')).toEqual([
		{ key: 2, mine: false, tvOnline: true },
		{ key: 3, mine: true, tvOnline: true }
	]);
	w.advance(TV_SEAT_GRACE_MS);
	expect(w.seats.sweep()).toEqual([]);
	expect(w.mine(2)).toBe(false);
});

test('two tabs of one screen: the newest is live, and closing it hands the seat to the other tab', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'tvA');
	expect(w.mine(1)).toBe(false);
	expect(w.seats.disconnect(ROOM, 2)).toEqual([{ key: 1, mine: true, tvOnline: true }]);
});

test('cookie cleared: the screen comes back as a copy and is promoted when the grace runs out', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.advance(ON_A_WHILE);
	w.seats.connect(ROOM, 2, 'laptop');
	w.seats.connect(ROOM, 3, undefined);
	w.seats.disconnect(ROOM, 1);
	// The same TV, with a fresh cookie, is now the NEWEST screen with one.
	w.seats.connect(ROOM, 4, 'tvA2');
	w.advance(TV_SEAT_GRACE_MS);
	// The newest copy with a cookie, not the older laptop tab and not the cookieless socket; the others hear a TV is live.
	expect(w.seats.sweep()).toEqual([
		{
			roomId: ROOM,
			notices: [
				{ key: 2, mine: false, tvOnline: true },
				{ key: 3, mine: false, tvOnline: true },
				{ key: 4, mine: true, tvOnline: true }
			]
		}
	]);
	expect(w.saved.get(ROOM)).toBe('tvA2');
});

test('a cookieless socket is never promoted, even when it is the newest', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.advance(ON_A_WHILE);
	w.seats.connect(ROOM, 2, 'tvB');
	w.seats.disconnect(ROOM, 1);
	w.seats.connect(ROOM, 3, undefined);
	w.advance(TV_SEAT_GRACE_MS);
	expect(w.seats.sweep()).toEqual([
		{
			roomId: ROOM,
			notices: [
				{ key: 3, mine: false, tvOnline: true },
				{ key: 2, mine: true, tvOnline: true }
			]
		}
	]);
});

test('the holder gone past the grace with nobody else connected: the seat goes free for the next screen', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.advance(ON_A_WHILE);
	w.seats.disconnect(ROOM, 1);
	w.advance(TV_SEAT_GRACE_MS);
	expect(w.seats.sweep()).toEqual([]);
	expect(w.saved.get(ROOM)).toBeNull();
	expect(w.seats.connect(ROOM, 2, 'tvB')).toEqual([{ key: 2, mine: true, tvOnline: true }]);
});

test('a connect after the grace has run out promotes without waiting for the sweep', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.advance(ON_A_WHILE);
	w.seats.disconnect(ROOM, 1);
	w.advance(TV_SEAT_GRACE_MS);
	expect(w.seats.connect(ROOM, 2, 'tvB')).toEqual([{ key: 2, mine: true, tvOnline: true }]);
});

test('"Make this the TV": the claimer takes the seat and the old holder becomes a copy, both told', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'tvB');
	expect(w.seats.claim(ROOM, 2)).toEqual([
		{ key: 1, mine: false, tvOnline: true },
		{ key: 2, mine: true, tvOnline: true }
	]);
	expect(w.saved.get(ROOM)).toBe('tvB');
	// The old holder reloading does not take it back.
	w.seats.connect(ROOM, 3, 'tvA');
	expect(w.mine(3)).toBe(false);
});

test('core restart: the persisted holder gets its seat back even when a copy reconnects first', () => {
	const w = world('tvA');
	// No TV is live yet, so the copy is told so at once (proposal 19).
	expect(w.seats.connect(ROOM, 1, 'tvB')).toEqual([{ key: 1, mine: false, tvOnline: false }]);
	w.advance(TV_SEAT_GRACE_MS - 1);
	expect(w.seats.sweep()).toEqual([]);
	expect(w.seats.connect(ROOM, 2, 'tvA')).toEqual([
		{ key: 1, mine: false, tvOnline: true },
		{ key: 2, mine: true, tvOnline: true }
	]);
});

test('core restart: a holder that never comes back yields to the copy after the slow-boot window', () => {
	const w = world('tvA');
	w.seats.connect(ROOM, 1, 'tvB');
	w.advance(TV_SEAT_SLOW_BOOT_MS);
	expect(w.seats.sweep()).toEqual([{ roomId: ROOM, notices: [{ key: 1, mine: true, tvOnline: true }] }]);
});

test('seats are per room', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect('room-2', 2, 'tvB');
	expect(w.seats.holds('room-2', 2)).toBe(true);
	expect(w.seats.holds(ROOM, 2)).toBe(false);
});

test('the cookie is read only in the shape we mint, and the seat is kept under a hash of it', () => {
	const v = 'A'.repeat(31) + '_';
	expect(readTvCookie(`encore_singer=x; encore_tv=${v}`)).toBe(v);
	expect(readTvCookie('encore_tv=short')).toBeUndefined();
	expect(readTvCookie(`encore_tv=${v}!`)).toBeUndefined();
	expect(readTvCookie(null)).toBeUndefined();
	const id = tvIdOf(`encore_tv=${v}`);
	expect(id).toBeString();
	expect(id).not.toBe(v);
	expect(tvIdOf(`encore_tv=${'B'.repeat(32)}`)).not.toBe(id);
	expect(tvIdOf('encore_tv=short')).toBeUndefined();
});

test('the promised numbers: a 15 s grace, and a 60 s slow-boot window', () => {
	expect(TV_SEAT_GRACE_MS).toBe(15_000);
	expect(TV_SEAT_SLOW_BOOT_MS).toBe(60_000);
});

test('core restart: a slow-booting TV keeps its seat past 15 s, though a copy reconnected at once', () => {
	const w = world('tvA');
	w.seats.connect(ROOM, 1, 'phone-tab');
	w.advance(59_999);
	expect(w.seats.sweep()).toEqual([]);
	expect(w.seats.connect(ROOM, 2, 'tvA')).toEqual([
		{ key: 1, mine: false, tvOnline: true },
		{ key: 2, mine: true, tvOnline: true }
	]);
	expect(w.mine(1)).toBe(false);
});

test('no copy is promoted while the holder connected within the last 60 s, however short its last stay', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'laptop');
	// The TV flaps while it boots: up, down, up for 5 s, down.
	w.seats.disconnect(ROOM, 1);
	w.advance(10_000);
	w.seats.connect(ROOM, 3, 'tvA');
	w.advance(5_000);
	w.seats.disconnect(ROOM, 3);
	w.advance(15_000);
	// 15 s gone, but its cookie connected 20 s ago: no promotion.
	expect(w.seats.sweep()).toEqual([]);
	w.advance(39_999);
	expect(w.seats.sweep()).toEqual([]);
	w.advance(1);
	// 60 s since that connect: the laptop takes the seat.
	expect(w.seats.sweep()).toEqual([{ roomId: ROOM, notices: [{ key: 2, mine: true, tvOnline: true }] }]);
});

test('a TV that was on a while gets exactly the 15 s grace when it goes', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'laptop');
	w.advance(ON_A_WHILE);
	w.seats.disconnect(ROOM, 1);
	w.advance(14_999);
	expect(w.seats.sweep()).toEqual([]);
	w.advance(1);
	expect(w.seats.sweep()).toEqual([{ roomId: ROOM, notices: [{ key: 2, mine: true, tvOnline: true }] }]);
});

test('core restart: once the saved TV is back, its next absence gets the plain 15 s grace again', () => {
	const w = world('tvA');
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'laptop');
	w.advance(ON_A_WHILE);
	w.seats.disconnect(ROOM, 1);
	w.advance(15_000);
	expect(w.seats.sweep()).toEqual([{ roomId: ROOM, notices: [{ key: 2, mine: true, tvOnline: true }] }]);
});

test('a seat move tells the old TV to go silent before it tells the new one to play, whatever their ages', () => {
	// The copy is the OLDER socket here, so socket order alone would send its `mine: true` first.
	const w = world();
	w.seats.connect(ROOM, 1, 'laptop');
	w.seats.claim(ROOM, 1);
	w.seats.connect(ROOM, 2, 'tvA');
	w.seats.claim(ROOM, 2);
	expect(w.seats.claim(ROOM, 1)).toEqual([
		{ key: 2, mine: false, tvOnline: true },
		{ key: 1, mine: true, tvOnline: true }
	]);
});

// `tvOnline`: a copy is told the truth when the TV drops and when a TV is back (proposal 19).
test('the TV drops: every copy hears tvOnline false; the TV returns: every copy hears true', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'phone');
	w.seats.connect(ROOM, 3, undefined);
	expect(w.seats.disconnect(ROOM, 1)).toEqual([
		{ key: 2, mine: false, tvOnline: false },
		{ key: 3, mine: false, tvOnline: false }
	]);
	expect(w.seats.connect(ROOM, 4, 'tvA')).toEqual([
		{ key: 2, mine: false, tvOnline: true },
		{ key: 3, mine: false, tvOnline: true },
		{ key: 4, mine: true, tvOnline: true }
	]);
});

test('the TV gone, a copy claims: the claimer is the TV, and the other copies hear a TV is live', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'phone');
	w.seats.connect(ROOM, 3, 'laptop');
	w.seats.disconnect(ROOM, 1);
	expect(w.seats.claim(ROOM, 3)).toEqual([
		{ key: 2, mine: false, tvOnline: true },
		{ key: 3, mine: true, tvOnline: true }
	]);
});

test('a second tab of the TV closing while another stays open tells the copies nothing', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'tvA');
	w.seats.connect(ROOM, 3, 'phone');
	expect(w.seats.disconnect(ROOM, 2)).toEqual([{ key: 1, mine: true, tvOnline: true }]);
	// A copy's own close changes nobody's answer.
	expect(w.seats.disconnect(ROOM, 3)).toEqual([]);
});

// THE BOOKED SWEEPS, on the fake clock: each case below is one where nothing else happens, so only the sweep that
// event booked can move the seat (review of #990, r3).
test('restart, the saved TV never returns, one copy connects: the sweep THAT CONNECT booked promotes it at 60 s', () => {
	const w = world('tvA');
	w.seats.connect(ROOM, 1, 'laptop');
	w.tick(59_999);
	expect(w.announced).toEqual([]);
	w.tick(1);
	expect(w.announced).toEqual([{ key: 1, mine: true, tvOnline: true }]);
});

test('the TV closes with a copy open and nothing else happens: the sweep THE CLOSE booked promotes the copy', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'laptop');
	w.tick(ON_A_WHILE + 1);
	expect(w.timers).toEqual([]);
	w.seats.disconnect(ROOM, 1);
	w.tick(15_000);
	expect(w.announced).toEqual([{ key: 2, mine: true, tvOnline: true }]);
});

test('a booked sweep that fires a hair early re-arms for what is left, so the wait still ends', () => {
	const w = world('tvA');
	w.seats.connect(ROOM, 1, 'laptop');
	const due = w.timers.find((t) => t.at === 1_000_000 + 60_000)!;
	// The 60 s timer fires 1 ms early: the slow-boot window is not over, so nothing moves...
	w.timers.splice(w.timers.indexOf(due), 1);
	// The 15 s sweep runs (and books nothing), so the only sweep left to end the wait is the one under test.
	w.tick(15_000);
	w.advance(44_999);
	due.run();
	expect(w.announced).toEqual([]);
	// ...but it booked one more sweep for the 1 ms left, and that one promotes the copy.
	w.tick(1);
	expect(w.announced).toEqual([{ key: 1, mine: true, tvOnline: true }]);
});

test('a claim by the screen that already holds the seat moves nothing and books nothing', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.timers.splice(0);
	for (let i = 0; i < 1000; i++) expect(w.seats.claim(ROOM, 1)).toEqual([]);
	expect(w.timers).toEqual([]);
	expect(w.mine(1)).toBe(true);
});

test('an older tab of the screen that holds the seat can still claim it: the guard is the socket, not the screen', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'tvA');
	expect(w.mine(2)).toBe(true);
	w.timers.splice(0);
	expect(w.seats.claim(ROOM, 1)).toEqual([
		{ key: 2, mine: false, tvOnline: true },
		{ key: 1, mine: true, tvOnline: true }
	]);
	expect(w.timers.map((t) => t.at - 1_000_000)).toEqual([15_000, 60_000]);
});

// The p10-tv-seat probe's flake: Bun's timer fired 1 ms before Date.now() said the wait was over, that sweep found
// nothing to do, and nothing else was booked, so the copy was never promoted.
test('a booked sweep that fires a millisecond early still promotes the copy: restart, and the TV closing', () => {
	const restart = world('tvA', 1);
	restart.seats.connect(ROOM, 1, 'laptop');
	restart.tick(59_999);
	expect(restart.announced).toEqual([]);
	restart.tick(1);
	expect(restart.announced).toEqual([{ key: 1, mine: true, tvOnline: true }]);

	const close = world(null, 1);
	close.seats.connect(ROOM, 1, 'tvA');
	close.seats.connect(ROOM, 2, 'laptop');
	close.tick(ON_A_WHILE + 1);
	close.seats.disconnect(ROOM, 1);
	close.tick(14_999);
	expect(close.announced).toEqual([]);
	close.tick(1);
	expect(close.announced).toEqual([{ key: 2, mine: true, tvOnline: true }]);
	// The re-booked sweep was the last: no timer is left running once nothing waits.
	close.tick(TV_SEAT_SLOW_BOOT_MS);
	expect(close.timers).toEqual([]);
});

// A copy a timed sweep promoted has no sweep booked at the end of its own 60 s window (only a connect or a claim
// books one), so when it closes early in that window the window outlasts the close's 15 s sweep by up to 45 s.
test('a promoted copy that closes inside its 60 s window hands over the moment the window ends', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 3, 'tablet');
	w.seats.connect(ROOM, 2, 'laptop');
	w.tick(ON_A_WHILE + 1);
	w.seats.disconnect(ROOM, 1);
	w.tick(15_000);
	expect(w.announced).toEqual([
		{ key: 3, mine: false, tvOnline: true },
		{ key: 2, mine: true, tvOnline: true }
	]);
	w.tick(10_000);
	w.seats.disconnect(ROOM, 2);
	// Step to each booked sweep in turn (`tick` runs every due timer at the END time): the close's 15 s sweep, the
	// first close's 60 s sweep, then 1 ms before the window ends.
	w.tick(15_000);
	w.tick(20_000);
	w.tick(14_999);
	expect(w.mine(3)).toBe(false);
	w.tick(1);
	expect(w.mine(3)).toBe(true);
});

test('each connect, close and claim books a sweep at 15 s and at 60 s', () => {
	const w = world();
	const booked = () => w.timers.splice(0).map((t) => t.at - 1_000_000);
	w.seats.connect(ROOM, 1, 'tvA');
	expect(booked()).toEqual([15_000, 60_000]);
	w.seats.connect(ROOM, 2, 'laptop');
	w.seats.claim(ROOM, 2);
	expect(booked()).toEqual([15_000, 60_000, 15_000, 60_000]);
	w.seats.disconnect(ROOM, 2);
	expect(booked()).toEqual([15_000, 60_000]);
});

test('a sweep that fires 1 ms early while the clock ticks to the deadline mid-sweep still re-arms', () => {
	// The clock the server reads can move between the sweep's own check (59 999 ms: not yet) and the re-arm's
	// (60 000 ms: due now), as it did on a loaded host. That moment must still book one more sweep.
	let now = 1_000_000;
	let tickAfter = Infinity;
	const timers: { at: number; run: () => void }[] = [];
	const announced: SeatNotice[] = [];
	const seats = new TvSeats({
		load: () => 'tvA',
		save: () => {},
		now: () => {
			if (--tickAfter === 0) now += 1;
			return now;
		},
		schedule: (ms, run) => timers.push({ at: now + ms, run }),
		announce: (n) => announced.push(...n)
	});
	seats.connect(ROOM, 1, 'laptop');
	const due = timers.find((t) => t.at === 1_060_000)!;
	timers.length = 0;
	now = 1_059_999;
	// The sweep reads the clock once (59 999 ms), then it ticks: the re-arm reads 60 000 ms.
	tickAfter = 2;
	due.run();
	expect(announced).toEqual([]);
	expect(timers.length, 'nothing was re-armed, so the copy is stranded').toBe(1);
	tickAfter = Infinity;
	timers[0]!.run();
	expect(announced).toEqual([{ key: 1, mine: true, tvOnline: true }]);
});
