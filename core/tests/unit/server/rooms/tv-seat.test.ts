// One TV per room: the seat rules, driven with a fake clock and store. The live-socket half (a copy's `ended` and
// position are ignored) is tests/unit/server/ws-socket-guards.test.ts.
import { test, expect } from 'bun:test';
import { TvSeats, TV_SEAT_GRACE_MS, readTvCookie, tvIdOf } from '$lib/server/rooms/tv-seat';

const ROOM = 'room-1';

function world(persisted: string | null = null) {
	let now = 1_000_000;
	const saved = new Map<string, string | null>([[ROOM, persisted]]);
	const seats = new TvSeats({ load: (r) => saved.get(r) ?? null, save: (r, h) => saved.set(r, h), now: () => now });
	return {
		seats,
		saved,
		advance: (ms: number) => (now += ms),
		mine: (key: number) => seats.holds(ROOM, key)
	};
}

test('the first screen takes a free seat; a second is a copy, and each is told', () => {
	const w = world();
	expect(w.seats.connect(ROOM, 1, 'tvA')).toEqual([{ key: 1, mine: true }]);
	expect(w.seats.connect(ROOM, 2, 'tvB')).toEqual([{ key: 2, mine: false }]);
	expect(w.mine(1)).toBe(true);
	expect(w.mine(2)).toBe(false);
	expect(w.saved.get(ROOM)).toBe('tvA');
});

test('a socket with no cookie never holds the seat, even a free one, and cannot claim it', () => {
	const w = world();
	expect(w.seats.connect(ROOM, 1, undefined)).toEqual([{ key: 1, mine: false }]);
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
		{ key: 1, mine: false },
		{ key: 3, mine: true }
	]);
	// The old socket's late close changes nothing.
	expect(w.seats.disconnect(ROOM, 1)).toEqual([]);
	expect(w.mine(3)).toBe(true);
});

test('reload: the old socket closes first, and the screen is back inside the grace with zero steps', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'tvB');
	w.seats.disconnect(ROOM, 1);
	w.advance(TV_SEAT_GRACE_MS - 1);
	// Not yet: the copy is not promoted while the holder's grace runs.
	expect(w.seats.sweep()).toEqual([]);
	expect(w.seats.connect(ROOM, 3, 'tvA')).toEqual([{ key: 3, mine: true }]);
	w.advance(TV_SEAT_GRACE_MS);
	expect(w.seats.sweep()).toEqual([]);
	expect(w.mine(2)).toBe(false);
});

test('two tabs of one screen: the newest is live, and closing it hands the seat to the other tab', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'tvA');
	expect(w.mine(1)).toBe(false);
	expect(w.seats.disconnect(ROOM, 2)).toEqual([{ key: 1, mine: true }]);
});

test('cookie cleared: the screen comes back as a copy and is promoted when the grace runs out', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'laptop');
	w.seats.connect(ROOM, 3, undefined);
	w.seats.disconnect(ROOM, 1);
	// The same TV, with a fresh cookie, is now the NEWEST screen with one.
	w.seats.connect(ROOM, 4, 'tvA2');
	w.advance(TV_SEAT_GRACE_MS);
	// The newest copy with a cookie, not the older laptop tab and not the cookieless socket.
	expect(w.seats.sweep()).toEqual([{ roomId: ROOM, notices: [{ key: 4, mine: true }] }]);
	expect(w.saved.get(ROOM)).toBe('tvA2');
});

test('a cookieless socket is never promoted, even when it is the newest', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'tvB');
	w.seats.disconnect(ROOM, 1);
	w.seats.connect(ROOM, 3, undefined);
	w.advance(TV_SEAT_GRACE_MS);
	expect(w.seats.sweep()).toEqual([{ roomId: ROOM, notices: [{ key: 2, mine: true }] }]);
});

test('the holder gone past the grace with nobody else connected: the seat goes free for the next screen', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.disconnect(ROOM, 1);
	w.advance(TV_SEAT_GRACE_MS);
	expect(w.seats.sweep()).toEqual([]);
	expect(w.saved.get(ROOM)).toBeNull();
	expect(w.seats.connect(ROOM, 2, 'tvB')).toEqual([{ key: 2, mine: true }]);
});

test('a connect after the grace has run out promotes without waiting for the sweep', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.disconnect(ROOM, 1);
	w.advance(TV_SEAT_GRACE_MS);
	expect(w.seats.connect(ROOM, 2, 'tvB')).toEqual([{ key: 2, mine: true }]);
});

test('"Make this the TV": the claimer takes the seat and the old holder becomes a copy, both told', () => {
	const w = world();
	w.seats.connect(ROOM, 1, 'tvA');
	w.seats.connect(ROOM, 2, 'tvB');
	expect(w.seats.claim(ROOM, 2)).toEqual([
		{ key: 1, mine: false },
		{ key: 2, mine: true }
	]);
	expect(w.saved.get(ROOM)).toBe('tvB');
	// The old holder reloading does not take it back.
	w.seats.connect(ROOM, 3, 'tvA');
	expect(w.mine(3)).toBe(false);
});

test('core restart: the persisted holder gets its seat back even when a copy reconnects first', () => {
	const w = world('tvA');
	expect(w.seats.connect(ROOM, 1, 'tvB')).toEqual([{ key: 1, mine: false }]);
	w.advance(TV_SEAT_GRACE_MS - 1);
	expect(w.seats.sweep()).toEqual([]);
	expect(w.seats.connect(ROOM, 2, 'tvA')).toEqual([{ key: 2, mine: true }]);
});

test('core restart: a holder that never comes back yields to the copy after the grace', () => {
	const w = world('tvA');
	w.seats.connect(ROOM, 1, 'tvB');
	w.advance(TV_SEAT_GRACE_MS);
	expect(w.seats.sweep()).toEqual([{ roomId: ROOM, notices: [{ key: 1, mine: true }] }]);
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
