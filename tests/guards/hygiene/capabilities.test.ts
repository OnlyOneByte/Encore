// The capability gate. Its value today is not that it refuses much — every joined singer is a host —
// but that the decision lives in ONE function, so narrowing it later is an edit there and nowhere else.
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

// --- The owner CONFIRMED all five authority rulings on 2026-09-09, every one "any joined
// singer is a host". These assertions pin each ruling to the capability that enforces it, so a flip of
// can() (narrowing any capability to a host role) reds the test naming that ruling. Published, non-source
// statement of record: the owner rulings, CONFIRMED 2026-09-09.
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
	// Pinning removal + last-write-wins mechanics belong to the cross-singer reorder change; the policy
	// side is that this resolves to "anyone".
	expect(can(anySinger, 'queue:reorder-any')).toBe(true);
});

test('— queue:remove-any (unchanged by the rulings) stays open to any joined singer', () => {
	expect(can(anySinger, 'queue:remove-any')).toBe(true);
});

// Q5 (no per-singer queue-depth cap) is a validateCommand concern, not a capability, so it has no can()
// assertion here — its guard lives in the queue add-arm tests. This comment records why it is absent.

/*
 * THE DOC-PARITY ARM IS RETIRED (2026-09-22), because its subject was deleted.
 *
 * It read `docs/ux/05-concurrency.md`'s "Owner rulings" section and asserted that every member of the
 * `Capability` union appeared there, and that all five rulings were still the status-quo option A — so the
 * published policy could not silently drift from `can`. The docs tree was cleaned up and that file went
 * with it, and a guard whose subject does not exist asserts nothing.
 *
 * WHAT STILL HOLDS THE POLICY. The arms above are the policy now: each names its ruling and asserts the
 * `can` result, so flipping any of them to a gated answer still reds here. What is lost is the prose
 * mirror, not the behaviour — and a mirror with nothing on the other side of it was the weaker half.
 */
