// guard: SettingsRepository's four room-scoped methods (getRoom/setRoom/hasRoom/getEffective) must
// take a REQUIRED roomId — no `= DEFAULT_ROOM_ID` initialiser — so a caller can never silently
// address the default room 'main' (#728). A defaulted parameter is invisible to `tsc` by
// construction, so nothing forces the Nth call site; #653 already shipped that exact bug. This is the
// same source-scan discipline the rooms chain used for the required listPublic(roomId) at
// rooms/room-identity-wiring.test.ts. Deleting a default is behaviour-preserving, so no behavioural
// test can red — this scan is what reds on base.
//
// Two arms plus sentinels, over comment-stripped source (blank-preserving, same stripper as the
// room-identity guard) so a commented-out signature cannot satisfy or defeat any match:
//   ARM 1 (load-bearing) — the mechanism: `roomId: string =` must occur 0 times in the repository.
//   ARM 2 (belt) — every bare `.getRoom()/.setRoom()/.hasRoom()/.getEffective()` across the seven
//                   production caller files must be gone (empty-paren shape only; see the known limit).
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/state
const REPO_FILE = join(import.meta.dir, 'settings-repository.ts');
const REPO = stripComments(readFileSync(REPO_FILE, 'utf8'));

// The seven production files that call the room-scoped methods (from the #728 census).
const CALLER_PATHS = [
	join(import.meta.dir, '..', '..', '..', 'server.ts'), // apps/core/server.ts
	join(import.meta.dir, '..', 'app.ts'),
	join(import.meta.dir, '..', 'singers', 'join.ts'),
	join(import.meta.dir, '..', '..', 'routes', 'api', 'settings', '+server.ts'),
	join(import.meta.dir, '..', '..', 'routes', 'api', 'settings', 'room', '+server.ts'),
	join(import.meta.dir, '..', '..', 'routes', 'settings', '+page.server.ts'),
	join(import.meta.dir, '..', '..', 'routes', 'tv', '+page.server.ts')
];
const CALLERS = CALLER_PATHS.map((p) => stripComments(readFileSync(p, 'utf8')));

test('ARM 1 — no room-scoped method defaults its roomId (#728)', () => {
	// The mechanism. On base this matches 4 times (getRoom/setRoom/hasRoom/getEffective at :65/:90/
	// :102/:107); after the fix it must be gone entirely.
	const defaults = [...REPO.matchAll(/roomId\s*:\s*string\s*=/g)];
	expect(defaults.length).toBe(0);
});

test('ARM 2 — no production caller invokes a room method with an empty argument list (#728)', () => {
	// Belt over the mechanism: count every bare-paren call across the seven caller files. On base this
	// names all 12 unscoped sites; after the fix it must be 0. KNOWN LIMIT (stated, not left to be
	// discovered): the empty-paren shape cannot see app.ts:203's setRoom(<body>) with a body but no
	// room — that is why ARM 1 is load-bearing. Once the defaults are gone, tsc enforces all 13 sites
	// forever, which is strictly stronger than either arm.
	const bare = /\.(getRoom|setRoom|hasRoom|getEffective)\(\s*\)/g;
	let total = 0;
	for (const src of CALLERS) total += [...src.matchAll(bare)].length;
	expect(total).toBe(0);
});

test('sentinel — the repository and its four methods still exist (non-vacuous) (#728)', () => {
	// If any of these fail the guard is testing the wrong file, not a green fix.
	expect(REPO).toMatch(/export class SettingsRepository/);
	for (const m of ['getRoom', 'setRoom', 'hasRoom', 'getEffective']) {
		expect(REPO).toMatch(new RegExp(`\\b${m}\\(`));
	}
});

test('sentinel — DEFAULT_ROOM_ID is still exported (fix removes the defaults, not the constant) (#728)', () => {
	// The fix deletes the `= DEFAULT_ROOM_ID` initialisers; the constant itself is still the value every
	// caller passes explicitly. If the constant were also deleted, ARM 1 would pass for the wrong reason.
	expect(REPO).toMatch(/export const DEFAULT_ROOM_ID\s*=/);
});

test('sentinel — the comment stripper blanks a signature it would otherwise match (#728)', () => {
	// Proves the stripper actually neutralises comments: a commented-out defaulted signature matches raw
	// (so ARM 1 could be fooled) but must NOT match once stripped.
	const planted = '// getRoom(roomId: string = DEFAULT_ROOM_ID): RoomSettings {';
	expect(/roomId\s*:\s*string\s*=/.test(planted)).toBe(true);
	expect(/roomId\s*:\s*string\s*=/.test(stripComments(planted))).toBe(false);
});

test('sentinel — ARM 2 really walks the caller files (census not vacuous) (#728)', () => {
	// The seven caller files must together contain at least 10 calls to the four methods (bare OR
	// scoped), so an empty/mis-pathed file set cannot pass ARM 2 by reading nothing.
	const anyCall = /\.(getRoom|setRoom|hasRoom|getEffective)\(/g;
	let total = 0;
	for (const src of CALLERS) total += [...src.matchAll(anyCall)].length;
	expect(total).toBeGreaterThanOrEqual(10);
});
