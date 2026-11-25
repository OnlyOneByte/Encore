// The capability gate. A joined singer runs the party; only the host runs the machine.
import { test, expect } from 'bun:test';
import { can, type Capability } from '$lib/server/capabilities';

const PARTY: Capability[] = ['player:control', 'queue:remove-any', 'queue:reorder-any'];
const HOST: Capability[] = [
	'settings:write-room',
	'settings:write-global',
	'operator:read',
	'media:delete',
	'media:edit',
	'people:reset'
];
const ALL = [...PARTY, ...HOST];

test('a joined singer holds every party capability', () => {
	for (const cap of PARTY) expect(can({ singerId: 's1' }, cap)).toBe(true);
});

test('a joined singer holds no host capability', () => {
	for (const cap of HOST) expect(can({ singerId: 's1' }, cap)).toBe(false);
});

test('the host holds every host capability, joined or not', () => {
	for (const cap of HOST) {
		expect(can({ host: true }, cap)).toBe(true);
		expect(can({ host: true, singerId: 's1' }, cap)).toBe(true);
	}
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
		expect(can({ host: false, singerId: 's1' }, cap)).toBe(PARTY.includes(cap));
	}
});

// The party rulings are each "any joined singer may". Pinning each to the capability that enforces it means narrowing
// one reds the test naming it. Queue-depth caps are a validateCommand concern and are guarded in the queue add-arm tests.
const anySinger = { singerId: 'guest-1' };

test('Q1 — skip stays open to any joined singer (player:control)', () => {
	expect(can(anySinger, 'player:control')).toBe(true);
});

test('Q2 — live guide/pitch/range controls stay open to anyone (player:control)', () => {
	expect(can(anySinger, 'player:control')).toBe(true);
});

test('Q3 — settings, both scopes, are the host only (proposal 30)', () => {
	expect(can(anySinger, 'settings:write-global')).toBe(false);
	expect(can(anySinger, 'settings:write-room')).toBe(false);
});

test('Q4 — cross-singer reorder stays open to everyone (queue:reorder-any)', () => {
	expect(can(anySinger, 'queue:reorder-any')).toBe(true);
});

test('— queue:remove-any (unchanged by the rulings) stays open to any joined singer', () => {
	expect(can(anySinger, 'queue:remove-any')).toBe(true);
});
