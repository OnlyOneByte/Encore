// The capability gate. Its value today is not that it refuses much — every joined singer is a host —
// but that the decision lives in ONE function, so narrowing it later is an edit there and nowhere else.
import { test, expect } from 'bun:test';
import { can, type Capability } from './capabilities';

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
	// This is the real change: player:command had NO gate, so any socket — a TV, a spectator, a script
	// on the LAN — could pause, skip or seek the room's music.
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
