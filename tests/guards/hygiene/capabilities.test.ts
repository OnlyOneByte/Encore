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

// The five authority rulings are each "any joined singer is a host". Pinning each to the capability that enforces
// it means a flip of can() — narrowing any capability to a host role — reds the test naming it. Queue-depth caps
// are a validateCommand concern rather than a capability, and are guarded in the queue add-arm tests.
const anySinger = { singerId: 'guest-1' };

test('Q1 — skip stays open to any joined singer (player:control)', () => {
	expect(can(anySinger, 'player:control')).toBe(true);
});

test('Q2 — live guide/pitch/range controls stay open to anyone (player:control)', () => {
	expect(can(anySinger, 'player:control')).toBe(true);
});

test('Q3 — deployment-scoped settings stay open to any joined singer (settings:write-global)', () => {
	expect(can(anySinger, 'settings:write-global')).toBe(true);
	expect(can(anySinger, 'settings:write-room')).toBe(true);
});

test('Q4 — cross-singer reorder stays open to everyone (queue:reorder-any)', () => {
	expect(can(anySinger, 'queue:reorder-any')).toBe(true);
});

test('— queue:remove-any (unchanged by the rulings) stays open to any joined singer', () => {
	expect(can(anySinger, 'queue:remove-any')).toBe(true);
});
