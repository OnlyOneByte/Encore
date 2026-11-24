// The wrong-key backoff on POST /api/host.
import { test, expect } from 'bun:test';
import { KeyTries } from '$lib/server/host-key';

const lock = (t: KeyTries, addr: string, now = 0) => {
	for (let i = 0; i < 6; i++) t.wrong(addr, now);
};

test('five wrong tries are free, then the wait starts at a minute and doubles, capped at an hour', () => {
	const t = new KeyTries();
	for (let i = 0; i < 5; i++) t.wrong('a', 0);
	expect(t.wait('a', 0)).toBe(0);
	t.wrong('a', 0);
	expect(t.wait('a', 0)).toBe(60_000);
	t.wrong('a', 0);
	expect(t.wait('a', 0)).toBe(120_000);
	for (let i = 0; i < 20; i++) t.wrong('a', 0);
	expect(t.wait('a', 0)).toBe(3_600_000);
	expect(t.wait('b', 0)).toBe(0);
});

test('the right key clears the address', () => {
	const t = new KeyTries();
	for (let i = 0; i < 7; i++) t.wrong('a', 0);
	t.right('a');
	expect(t.wait('a', 0)).toBe(0);
});

test('a locked address stays locked through a flood of 2000 other addresses', () => {
	const t = new KeyTries();
	lock(t, 'attacker');
	for (let i = 0; i < 2000; i++) t.wrong(`flood-${i}`, 1);
	expect(t.wait('attacker', 2)).toBe(60_000 - 2);
	t.wrong('attacker', 2);
	expect(t.wait('attacker', 2)).toBe(120_000);
});

test('when full, a free entry goes first, then an expired lock, and never a live lock', () => {
	const t = new KeyTries(3);
	lock(t, 'locked', 0);
	lock(t, 'expired', -120_000);
	t.wrong('free', 0);
	t.wrong('new-1', 0);
	expect(t.wait('locked', 0)).toBeGreaterThan(0);
	// `free` went; `expired` is next, still tracked with its count.
	t.wrong('new-2', 0);
	t.wrong('new-3', 0);
	expect(t.wait('locked', 0)).toBeGreaterThan(0);
});

test('a table full of live locks answers a new address with a wait instead of evicting one', () => {
	const t = new KeyTries(3);
	for (const a of ['a', 'b', 'c']) lock(t, a);
	expect(t.wait('newcomer', 0)).toBe(60_000);
	t.wrong('newcomer', 0);
	for (const a of ['a', 'b', 'c']) expect(t.wait(a, 0)).toBe(60_000);
	// Once the locks run out, room is made again.
	expect(t.wait('newcomer', 60_001)).toBe(0);
});
