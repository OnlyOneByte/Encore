// guard: SettingsRepository's four room-scoped methods (getRoom/setRoom/hasRoom/getEffective) must take a
// REQUIRED roomId — no default initialiser — so a caller can never silently address the default room 'main'. A
// defaulted parameter is invisible to `tsc`, so nothing forces the Nth call site; the un-threaded roomId on
// PUT /api/settings/room already shipped that bug, and deleting a default is behaviour-preserving, so only a
// source scan can red on base. ARMS 3 and 4 keep DEFAULT_ROOM_ID deleted from CODE: it had zero non-test callers
// and a docstring claiming 'main' IS the default room's id, which `rooms.byId('main')` returns null for, so
// `getRoom(DEFAULT_ROOM_ID)` type-checked, threw nothing and served pristine defaults instead of the room the box
// was running. Both arms are comment-stripped, banning the identifier from CODE only.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at, srcDir } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// ARM 4's census is the dangerous one: a wrong root yields an empty file list, which reads like a clean tree.
const REPO_FILE = at('src/lib/server/state/settings-repository.ts');
const REPO_RAW = readFileSync(REPO_FILE, 'utf8');
const REPO = stripComments(REPO_RAW);

// Every NON-TEST file the app ships: all of src plus server.ts, which sits OUTSIDE src and a src-scoped grep misses.
const SRC_DIR = srcDir;
const PROD_FILES = [
	at('server.ts'),
	...readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
		.filter((p) => /\.(ts|svelte)$/.test(p) && !/\.test\.ts$/.test(p))
		.map((p) => join(SRC_DIR, p))
];

// The seven production files that call the room-scoped methods (from the roomId-default census).
const CALLER_PATHS = [
	at('server.ts'), // the Bun.serve entry, outside src
	at('src/lib/server/app.ts'),
	at('src/lib/server/singers/join.ts'),
	at('src/routes/api/settings/+server.ts'),
	at('src/routes/api/settings/room/+server.ts'),
	at('src/routes/settings/+page.server.ts'),
	at('src/routes/tv/+page.server.ts')
];
const CALLERS = CALLER_PATHS.map((p) => stripComments(readFileSync(p, 'utf8')));

test('ARM 1 — no room-scoped method defaults its roomId', () => {
	// The mechanism. On base this matches 4 times (one per method); after the fix it must be gone entirely.
	const defaults = [...REPO.matchAll(/roomId\s*:\s*string\s*=/g)];
	expect(defaults.length).toBe(0);
});

test('ARM 2 — no production caller invokes a room method with an empty argument list', () => {
	// Belt over the mechanism. KNOWN LIMIT: the empty-paren shape cannot see `setRoom(<body>)` with a body but no
	// room — that is why ARM 1 is load-bearing. Once the defaults are gone, tsc enforces every site.
	const bare = /\.(getRoom|setRoom|hasRoom|getEffective)\(\s*\)/g;
	let total = 0;
	for (const src of CALLERS) total += [...src.matchAll(bare)].length;
	expect(total).toBe(0);
});

test('sentinel — the repository and its four methods still exist (non-vacuous)', () => {
	expect(REPO).toMatch(/export class SettingsRepository/);
	for (const m of ['getRoom', 'setRoom', 'hasRoom', 'getEffective']) {
		expect(REPO).toMatch(new RegExp(`\\b${m}\\(`));
	}
});

test('ARM 3 — the repository no longer names DEFAULT_ROOM_ID in CODE', () => {
	// PURE DELETION, so nothing behavioural can red. Banned from CODE only.
	expect(REPO).not.toMatch(/DEFAULT_ROOM_ID/);
});

test('ARM 4 — no non-test production file under . contains DEFAULT_ROOM_ID in CODE', () => {
	// Wider than ARM 3: the constant must not come back anywhere a production caller could reach it.
	// drizzle/0004_rekey_room_settings.sql still names it as shipped historical prose; .sql is not scanned.
	const offenders = PROD_FILES.filter((f) => stripComments(readFileSync(f, 'utf8')).includes('DEFAULT_ROOM_ID'));
	expect(offenders).toEqual([]);
});

test('sentinel — ARM 4 really walks the production tree (census not vacuous)', () => {
	expect(PROD_FILES.length).toBeGreaterThanOrEqual(50);
	expect(PROD_FILES).toContain(REPO_FILE);
	expect(PROD_FILES.some((f) => readFileSync(f, 'utf8').includes('export class SettingsRepository'))).toBe(true);
});

test('sentinel — the comment stripper blanks a signature it would otherwise match', () => {
	// A commented-out defaulted signature matches raw (so ARM 1 could be fooled) but must NOT match stripped.
	const planted = "// getRoom(roomId: string = 'main'): RoomSettings {";
	expect(/roomId\s*:\s*string\s*=/.test(planted)).toBe(true);
	expect(/roomId\s*:\s*string\s*=/.test(stripComments(planted))).toBe(false);
});

test('sentinel — ARM 2 really walks the caller files (census not vacuous)', () => {
	// At least 10 calls across the seven files, so a mis-pathed set cannot pass ARM 2 by reading nothing.
	const anyCall = /\.(getRoom|setRoom|hasRoom|getEffective)\(/g;
	let total = 0;
	for (const src of CALLERS) total += [...src.matchAll(anyCall)].length;
	expect(total).toBeGreaterThanOrEqual(10);
});
