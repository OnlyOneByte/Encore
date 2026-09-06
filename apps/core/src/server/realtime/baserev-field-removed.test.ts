// Regression for issue #348: `ClientCommand.baseRev` was a required field, minted client-side,
// documented as an optimistic-concurrency check — and read by NOTHING on the server. Worse, it
// could not simply be wired: `rev` is a ROOM revision that `setPlayback` (a pause) bumps
// (store.ts), so a naive `baseRev !== state.rev → reject` would spuriously reject valid queue
// commands after any pause/play/key/guide/background change. The ratified fix (issue §4) is to
// DELETE the dead field — behaviour-preserving, and it removes the false-mechanism invitation for
// the next developer to trust a check that does not exist.
//
// These guards keep the field gone. They have no runtime harness to exercise (there is nothing to
// exercise — the field did nothing), so both are SOURCE SCANS, the established idiom for a repo
// with no CI. Comments are blanked (stripComments) so the explanatory prose above — which names
// `baseRev` — can neither satisfy nor trip the scans.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/\/\*[\s\S]*?\*\//g, blank) // block comments
		.replace(/\/\/[^\n]*/g, blank); // line comments
}

// import.meta.dir === apps/core/src/server/realtime → repo root is five levels up.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
const OPS_PATH = join(REPO_ROOT, 'packages', 'shared', 'src', 'ops.ts');
// apps/core/src — the server + client TypeScript that could read the field.
const CORE_SRC = join(import.meta.dir, '..', '..');
const CORE_ENTRY = join(import.meta.dir, '..', '..', '..', 'server.ts');

// Slice out the `export interface ClientCommand { ... }` body via a brace-depth walk located from
// its unique declaration, so we assert on the CONTRACT itself, not on a substring anywhere in the
// file (ServerPatch etc. must not leak into the match).
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

test('ClientCommand no longer carries baseRev, and still carries its live fields (#348)', () => {
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
	out.push(CORE_ENTRY); // the Bun.serve entry lives at apps/core/server.ts
	return out;
}

test('no non-test source under apps/core references baseRev (#348)', () => {
	const files = collectSources(CORE_SRC);
	// Sentinel: a broken walk that finds nothing must not pass vacuously.
	expect(files.length).toBeGreaterThan(50);
	const offenders = files
		.filter((f) => /\bbaseRev\b/.test(stripComments(readFileSync(f, 'utf8'))))
		.map((f) => f.slice(REPO_ROOT.length + 1))
		.sort();
	// Any writer or reader of the dead field — the client store, the server entry, a new consumer —
	// reds this with the offending path named.
	expect(offenders).toEqual([]);
});
