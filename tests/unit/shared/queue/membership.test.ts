// The membership policy as a truth table. The rule worth protecting: a pending song holds you in the
// room at EVERY grace setting, because that is what makes the clock meaningful rather than a second
// disconnect timer.
import { test, expect } from 'bun:test';
import {
	memberState,
	shouldStartClock,
	shouldClearClock,
	graceMsOf,
	DEFAULT_PRESENCE_GRACE_MINUTES,
	type MemberFacts
} from '../../../../apps/core/src/lib/contract/queue/membership';

const NOW = 1_000_000;
const GRACE = graceMsOf(90);
const facts = (over: Partial<MemberFacts> = {}): MemberFacts => ({ sockets: 0, hasPendingSongs: false, ...over });

test('a live socket is here, whatever else is true', () => {
	expect(memberState(facts({ sockets: 1 }), NOW, GRACE)).toBe('here');
	// even with an expired clock still recorded — reconnecting wins
	expect(memberState(facts({ sockets: 2, awaySince: 0, clockStartedAt: 0 }), NOW, GRACE)).toBe('here');
});

test('never seen is gone, which is what keeps a restarted roster empty', () => {
	expect(memberState(facts(), NOW, GRACE)).toBe('gone');
});

test('a locked phone is AWAY, not gone — this is the whole point', () => {
	expect(memberState(facts({ awaySince: NOW - 1000 }), NOW, GRACE)).toBe('away');
});

test('pending songs hold you in the room past the grace window', () => {
	const long = facts({ awaySince: NOW - GRACE * 10, clockStartedAt: NOW - GRACE * 10, hasPendingSongs: true });
	expect(memberState(long, NOW, GRACE)).toBe('away');
});

test('pending songs hold you in the room even at zero grace', () => {
	// 0 means "no grace once your songs are done", NOT "vanish the instant your socket drops".
	expect(memberState(facts({ awaySince: NOW, hasPendingSongs: true }), NOW, 0)).toBe('away');
});

test('an unstarted clock is away — the sweep has not reached them yet', () => {
	expect(memberState(facts({ awaySince: NOW - GRACE * 5 }), NOW, GRACE)).toBe('away');
});

test('the clock expiring is what makes someone gone', () => {
	expect(memberState(facts({ awaySince: NOW - GRACE, clockStartedAt: NOW - GRACE + 1 }), NOW, GRACE)).toBe('away');
	expect(memberState(facts({ awaySince: NOW - GRACE, clockStartedAt: NOW - GRACE }), NOW, GRACE)).toBe('gone');
});

test('zero grace expires the moment the clock starts', () => {
	expect(memberState(facts({ awaySince: NOW, clockStartedAt: NOW }), NOW, 0)).toBe('gone');
});

test('the clock starts only when away with nothing pending', () => {
	expect(shouldStartClock(facts({ awaySince: NOW }))).toBe(true);
	expect(shouldStartClock(facts({ sockets: 1, awaySince: NOW }))).toBe(false); // here
	expect(shouldStartClock(facts({ awaySince: NOW, hasPendingSongs: true }))).toBe(false); // has a stake
	expect(shouldStartClock(facts())).toBe(false); // never seen
	expect(shouldStartClock(facts({ awaySince: NOW, clockStartedAt: NOW }))).toBe(false); // already running
});

test('the clock clears on reconnect or on queueing another song', () => {
	expect(shouldClearClock(facts({ clockStartedAt: NOW, sockets: 1 }))).toBe(true);
	expect(shouldClearClock(facts({ clockStartedAt: NOW, hasPendingSongs: true }))).toBe(true);
	expect(shouldClearClock(facts({ clockStartedAt: NOW }))).toBe(false);
	expect(shouldClearClock(facts({ sockets: 1 }))).toBe(false); // nothing to clear
});

test('grace minutes convert to ms and never go negative', () => {
	expect(graceMsOf(90)).toBe(5_400_000);
	expect(graceMsOf(0)).toBe(0);
	expect(graceMsOf(-5)).toBe(0);
	expect(DEFAULT_PRESENCE_GRACE_MINUTES).toBe(90);
});
