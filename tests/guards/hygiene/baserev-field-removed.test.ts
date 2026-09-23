// guard: `ClientCommand.baseRev` was a required field, minted client-side, documented as an
// optimistic-concurrency check — and read by NOTHING on the server. It could not simply be wired either:
// `rev` is a ROOM revision that `setPlayback` (a pause) bumps, so a naive `baseRev !== state.rev → reject`
// would spuriously reject valid queue commands after any pause/play/key/guide/background change. The field
// is deleted; these scans keep it gone. Comments are blanked so the prose above cannot satisfy or trip them.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { at, e2eDir, repoRoot, srcDir } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/\/\*[\s\S]*?\*\//g, blank) // block comments
		.replace(/\/\/[^\n]*/g, blank); // line comments
}

// Anchored on the repo root marker rather than counted up from this file's own location.
const REPO_ROOT = repoRoot;
const OPS_PATH = at('src', 'lib', 'contract', 'core', 'ops.ts');
const CORE_SRC = srcDir;
const CORE_ENTRY = at('server.ts');

// Slice out the `export interface ClientCommand { ... }` body via a brace-depth walk, so we assert on the
// CONTRACT itself and ServerPatch etc. cannot leak into the match.
function clientCommandBody(): string {
	const src = stripComments(readFileSync(OPS_PATH, 'utf8'));
	const decl = src.indexOf('interface ClientCommand');
	expect(decl).toBeGreaterThanOrEqual(0); // non-vacuous: the interface must exist
	const open = src.indexOf('{', decl);
	expect(open).toBeGreaterThan(decl);
	let depth = 0;
	let end = -1;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}' && --depth === 0) {
			end = i;
			break;
		}
	}
	expect(end).toBeGreaterThan(open);
	return src.slice(open + 1, end);
}

test('ClientCommand no longer carries baseRev, and still carries its live fields', () => {
	const body = clientCommandBody();
	// The live fields stay — proves we sliced the real interface, not an empty match.
	expect(body).toMatch(/\bclientOpId\b/);
	expect(body).toMatch(/\bop\b/);
	// The dead field is gone. Re-adding `baseRev: number;` to the interface reds this.
	expect(body).not.toMatch(/\bbaseRev\b/);
});

function collectSources(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			if (['node_modules', '.svelte-kit', 'build', 'dist'].includes(name)) continue;
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
		}
	};
	walk(root);
	out.push(CORE_ENTRY); // the Bun.serve entry lives at server.ts
	return out;
}

test('no non-test source under . references baseRev', () => {
	const files = collectSources(CORE_SRC);
	// Sentinel: a broken walk that finds nothing must not pass vacuously.
	expect(files.length).toBeGreaterThan(50);
	const offenders = files
		.filter((f) => /\bbaseRev\b/.test(stripComments(readFileSync(f, 'utf8'))))
		.map((f) => f.slice(REPO_ROOT.length + 1))
		.sort();
	// Any writer or reader of the dead field — client store, server entry, a new consumer — reds this by path.
	expect(offenders).toEqual([]);
});

// The scans above do NOT reach the e2e harness: `tests/e2e/**/*.mjs` are live-server scripts nothing in
// `bun test` invokes, so the deletion left three of them still sending the dead field. This bans the
// AFFIRMATIVE declaration `baseRev:`, not the bare word: the probes legitimately NAME it as the removed
// field inside a `report()` string literal, which stripComments cannot blank, and a bare-word ban self-reds.
const E2E_DIR = e2eDir;

function collectMjs(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			if (['node_modules', '.svelte-kit', 'build', 'dist'].includes(name)) continue;
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (/\.mjs$/.test(name)) out.push(p);
		}
	};
	walk(root);
	return out;
}

test('no e2e .mjs harness script sends the dead baseRev field', () => {
	const files = collectMjs(E2E_DIR);
	// Sentinel: a broken walk that finds nothing must not pass vacuously (fuzz + party + probes/*).
	expect(files.length).toBeGreaterThan(10);
	const offenders = files
		.filter((f) => /\bbaseRev\s*:/.test(stripComments(readFileSync(f, 'utf8'))))
		.map((f) => f.slice(REPO_ROOT.length + 1))
		.sort();
	// Re-adding `baseRev: <value>` to any e2e command envelope reds this with the offending path named.
	expect(offenders).toEqual([]);
});
