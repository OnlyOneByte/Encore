// guard: SettingsRepository's four room-scoped methods (getRoom/setRoom/hasRoom/getEffective) must
// take a REQUIRED roomId — no default initialiser at all — so a caller can never silently
// address the default room 'main'. A defaulted parameter is invisible to `tsc` by
// construction, so nothing forces the Nth call site; the un-threaded roomId on PUT
// /api/settings/room already shipped that exact bug. This is the same source-scan discipline the
// rooms chain used for the required listPublic(roomId) at
// rooms/room-identity-wiring.test.ts. Deleting a default is behaviour-preserving, so no behavioural
// test can red — this scan is what reds on base.
//
// Two arms plus sentinels, over comment-stripped source (blank-preserving, same stripper as the
// room-identity guard) so a commented-out signature cannot satisfy or defeat any match:
//   ARM 1 (load-bearing) — the mechanism: `roomId: string =` must occur 0 times in the repository.
//   ARM 2 (belt) — every bare `.getRoom()/.setRoom()/.hasRoom()/.getEffective()` across the seven
//                   production caller files must be gone (empty-paren shape only; see the known limit).
//
// The DEFAULT_ROOM_ID report adds two more arms, over RAW source this time. The roomId default
// removal removed the parameter defaults but left the exported constant they had named, with zero
// non-test callers and a docstring asserting 'main' IS "the
// default room's id" — which `rooms.byId('main')` returns null for, because RoomRepository.create mints
// a ULID. `settings.getRoom(DEFAULT_ROOM_ID)` therefore type-checked, threw nothing, and served
// pristine defaults instead of the room the box was running: that same failure mode, one autocomplete
// away. The constant is deleted; these two arms keep it deleted.
//   ARM 3 — the identifier occurs 0 times in the repository, comments INCLUDED, so neither the export
//           nor the docstring that made it look correct can come back.
//   ARM 4 — no NON-TEST file under apps/core/src, plus apps/core/server.ts, mentions it either, so it
//           cannot be reintroduced somewhere else and re-acquire a production caller.
// Both read raw rather than stripped source deliberately: stripping would let the misleading docstring
// return, and the comment contradicting its code is half of what the DEFAULT_ROOM_ID report flagged.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appSrc, at } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Every path below is named absolutely rather than counted from this file's own location —
// `at('apps/core/src/lib/server/state/settings-repository.ts')` meant "the repository next to me", and the two
// census walks meant "apps/core/src" and "apps/core/server.ts" by arithmetic. ARM 4's census is the
// dangerous one: a wrong root yields an empty file list, which reads exactly like a clean tree.
const REPO_FILE = at('apps/core/src/lib/server/state/settings-repository.ts');
const REPO_RAW = readFileSync(REPO_FILE, 'utf8');
const REPO = stripComments(REPO_RAW);

// Every NON-TEST source file the app ships from apps/core: the whole of src, plus server.ts (the
// Bun.serve entry, which sits OUTSIDE src and is exactly the file a src-scoped grep misses).
const SRC_DIR = appSrc;
const PROD_FILES = [
	at('apps/core/server.ts'),
	...readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
		.filter((p) => /\.(ts|svelte)$/.test(p) && !/\.test\.ts$/.test(p))
		.map((p) => join(SRC_DIR, p))
];

// The seven production files that call the room-scoped methods (from the roomId-default census).
const CALLER_PATHS = [
	at('apps/core/server.ts'), // the Bun.serve entry, outside src
	at('apps/core/src/lib/server/app.ts'),
	at('apps/core/src/lib/server/singers/join.ts'),
	at('apps/core/src/routes/api/settings/+server.ts'),
	at('apps/core/src/routes/api/settings/room/+server.ts'),
	at('apps/core/src/routes/settings/+page.server.ts'),
	at('apps/core/src/routes/tv/+page.server.ts')
];
const CALLERS = CALLER_PATHS.map((p) => stripComments(readFileSync(p, 'utf8')));

test('ARM 1 — no room-scoped method defaults its roomId', () => {
	// The mechanism. On base this matches 4 times (getRoom/setRoom/hasRoom/getEffective at :65/:90/
	// :102/:107); after the fix it must be gone entirely.
	const defaults = [...REPO.matchAll(/roomId\s*:\s*string\s*=/g)];
	expect(defaults.length).toBe(0);
});

test('ARM 2 — no production caller invokes a room method with an empty argument list', () => {
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

test('sentinel — the repository and its four methods still exist (non-vacuous)', () => {
	// If any of these fail the guard is testing the wrong file, not a green fix.
	expect(REPO).toMatch(/export class SettingsRepository/);
	for (const m of ['getRoom', 'setRoom', 'hasRoom', 'getEffective']) {
		expect(REPO).toMatch(new RegExp(`\\b${m}\\(`));
	}
});

test('ARM 3 — the repository no longer names DEFAULT_ROOM_ID at all, comments included', () => {
	// PURE DELETION, so nothing behavioural can red: reverting it re-adds a symbol nothing calls and the
	// suite stays green. This scan is the proof. RAW source on purpose — the docstring asserting 'main'
	// IS "the default room's id" is itself the defect's other half, so a stripped read would let it back.
	expect(REPO_RAW).not.toMatch(/DEFAULT_ROOM_ID/);
});

test('ARM 4 — no non-test production file under apps/core mentions DEFAULT_ROOM_ID', () => {
	// Wider than ARM 3: the constant must not come back anywhere a production caller could reach it.
	// Only apps/core/drizzle/0004_rekey_room_settings.sql still names it, as shipped historical prose
	// about the pre-default-removal world; a .sql migration is not scanned here and must not be edited.
	const offenders = PROD_FILES.filter((f) => readFileSync(f, 'utf8').includes('DEFAULT_ROOM_ID'));
	expect(offenders).toEqual([]);
});

test('sentinel — ARM 4 really walks the production tree (census not vacuous)', () => {
	// A mis-pathed or empty file list would make ARM 4 pass by reading nothing. Require both a
	// plausible file count and that the walk actually reached the repository under test.
	expect(PROD_FILES.length).toBeGreaterThanOrEqual(50);
	expect(PROD_FILES).toContain(REPO_FILE);
	expect(PROD_FILES.some((f) => readFileSync(f, 'utf8').includes('export class SettingsRepository'))).toBe(true);
});

test('sentinel — the comment stripper blanks a signature it would otherwise match', () => {
	// Proves the stripper actually neutralises comments: a commented-out defaulted signature matches raw
	// (so ARM 1 could be fooled) but must NOT match once stripped.
	const planted = "// getRoom(roomId: string = 'main'): RoomSettings {";
	expect(/roomId\s*:\s*string\s*=/.test(planted)).toBe(true);
	expect(/roomId\s*:\s*string\s*=/.test(stripComments(planted))).toBe(false);
});

test('sentinel — ARM 2 really walks the caller files (census not vacuous)', () => {
	// The seven caller files must together contain at least 10 calls to the four methods (bare OR
	// scoped), so an empty/mis-pathed file set cannot pass ARM 2 by reading nothing.
	const anyCall = /\.(getRoom|setRoom|hasRoom|getEffective)\(/g;
	let total = 0;
	for (const src of CALLERS) total += [...src.matchAll(anyCall)].length;
	expect(total).toBeGreaterThanOrEqual(10);
});
