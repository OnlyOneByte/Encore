// The capability gate. Its value today is not that it refuses much — every joined singer is a host —
// but that the decision lives in ONE function, so narrowing it later is an edit there and nowhere else.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// --- Issue #828: the owner CONFIRMED all five authority rulings on 2026-09-09, every one "any joined
// singer is a host". These assertions pin each ruling to the capability that enforces it, so a flip of
// can() (narrowing any capability to a host role) reds the test naming that ruling. Published, non-source
// statement of record: docs/ux/05-concurrency.md § "Owner rulings — CONFIRMED 2026-09-09".
const anySinger = { singerId: 'guest-1' };

test('#828 Q1 — skip stays open to any joined singer (player:control)', () => {
	// skip is a player:command, gated on player:control at server.ts:379.
	expect(can(anySinger, 'player:control')).toBe(true);
});

test('#828 Q2 — live guide/pitch/range controls stay open to anyone (player:control)', () => {
	// key/guide arms of handlePlayerCommand ride the same player:control gate — no new capability.
	expect(can(anySinger, 'player:control')).toBe(true);
});

test('#828 Q3 — deployment-scoped settings stay open to any joined singer (settings:write-global)', () => {
	expect(can(anySinger, 'settings:write-global')).toBe(true);
	// room-scoped stays open too (safe for anyone by construction).
	expect(can(anySinger, 'settings:write-room')).toBe(true);
});

test('#828 Q4 — cross-singer reorder stays open to everyone (queue:reorder-any)', () => {
	// Pinning removal + last-write-wins mechanics are #856; the policy side is that this resolves to "anyone".
	expect(can(anySinger, 'queue:reorder-any')).toBe(true);
});

test('#828 — queue:remove-any (unchanged by #828) stays open to any joined singer', () => {
	expect(can(anySinger, 'queue:remove-any')).toBe(true);
});

// Q5 (no per-singer queue-depth cap) is a validateCommand concern, not a capability, so it has no can()
// assertion here — its guard lives in the queue add-arm tests. This comment records why it is absent.

test('#828 — the published policy doc states every capability AND records the correct ruling letter, so the doc cannot silently drift from can()', () => {
	// Mirrors XR-CON-06's Check: every member of the Capability union must appear in the policy document.
	const doc = readFileSync(
		fileURLToPath(new URL('../../../../../docs/ux/05-concurrency.md', import.meta.url)),
		'utf-8'
	);
	// Guard the slice: a missing heading makes indexOf return -1, and slice(-1) would silently keep
	// only the last char and pass the loop below vacuously. Assert the heading exists first.
	expect(doc.includes('## Owner rulings')).toBe(true);
	const start = doc.indexOf('## Owner rulings');
	// Scope to the rulings section only (heading up to the next top-level heading).
	const afterHeading = doc.slice(start + '## Owner rulings'.length);
	const nextTop = afterHeading.indexOf('\n## ');
	const rulings = nextTop === -1 ? afterHeading : afterHeading.slice(0, nextTop);
	expect(rulings.length).toBeGreaterThan(0);
	for (const cap of ALL) {
		expect(rulings.includes(cap)).toBe(true);
	}
	// Non-vacuous letter check: the owner ruled the status-quo option (A) for ALL FIVE questions.
	// Every ruling cell must be `**A — ...`; flipping any row to B/C/D (the gated policies the owner
	// declined) must red this test. The five rows are the only `**<letter> — ` cells in the section.
	const aCells = rulings.match(/\*\*A —/g) ?? [];
	expect(aCells.length).toBe(5);
	expect(/\*\*B —/.test(rulings)).toBe(false);
	expect(/\*\*C —/.test(rulings)).toBe(false);
	expect(/\*\*D —/.test(rulings)).toBe(false);
});
