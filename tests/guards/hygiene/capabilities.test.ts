// The capability gate. Every joined singer is a host today; the value is that the decision lives in ONE
// function, so narrowing it later is an edit there and nowhere else.
import { test, expect } from 'bun:test';
import { can, type Capability } from '$lib/server/capabilities';

const ALL: Capability[] = [
	'player:control',
	'queue:remove-any',
	'queue:reorder-any',
	'settings:write-room',
	'settings:write-global'
];

test('a joined singer holds every capability today', () => {
	for (const cap of ALL) expect(can({ singerId: 's1' }, cap)).toBe(true);
});

test('a socket that never joined holds none', () => {
	// The real change: player:command had NO gate — any socket on the LAN could pause, skip or seek the music.
	for (const cap of ALL) expect(can({ singerId: undefined }, cap)).toBe(false);
});

test('a missing or empty actor is refused rather than treated as trusted', () => {
	for (const cap of ALL) {
		expect(can(null, cap)).toBe(false);
		expect(can(undefined, cap)).toBe(false);
		expect(can({}, cap)).toBe(false);
		expect(can({ singerId: '' }, cap)).toBe(false);
	}
});

// The five authority rulings are each "any joined singer is a host". Pinning each to the capability that
// enforces it means a flip of can() — narrowing any capability to a host role — reds the test naming it.
const anySinger = { singerId: 'guest-1' };

test('Q1 — skip stays open to any joined singer (player:control)', () => {
	// skip is a player:command, gated on player:control at server.ts:379.
	expect(can(anySinger, 'player:control')).toBe(true);
});

test('Q2 — live guide/pitch/range controls stay open to anyone (player:control)', () => {
	// key/guide arms of handlePlayerCommand ride the same player:control gate — no new capability.
	expect(can(anySinger, 'player:control')).toBe(true);
});

test('Q3 — deployment-scoped settings stay open to any joined singer (settings:write-global)', () => {
	expect(can(anySinger, 'settings:write-global')).toBe(true);
	// room-scoped stays open too (safe for anyone by construction).
	expect(can(anySinger, 'settings:write-room')).toBe(true);
});

test('Q4 — cross-singer reorder stays open to everyone (queue:reorder-any)', () => {
	// Pinning removal + last-write-wins mechanics belongs elsewhere; the policy side resolves to "anyone".
	expect(can(anySinger, 'queue:reorder-any')).toBe(true);
});

test('— queue:remove-any (unchanged by the rulings) stays open to any joined singer', () => {
	expect(can(anySinger, 'queue:remove-any')).toBe(true);
});

// Q5 (no per-singer queue-depth cap) is a validateCommand concern, not a capability; its guard is in the
// queue add-arm tests.
