// — a comment can point a reader to another file for a symbol ("`X` in `foo.ts`") and rot when
// that symbol MOVES file. Symbol naming does not protect a cross-file pointer: `lyrics-engines.ts`
// named `tvProgressStyle` and `resolveLyricsPresentation` "in separators.ts" by symbol, and both rotted
// when `0addb65` moved the config layer into `settings.ts`. Same class as pitch-shift.ts's
// rotted citations.
//
// Comment stripping is INVERTED on purpose: the defect lives IN the source comments, so the SOURCE side
// is read as comment text (never stripped) while the TARGET side is comment-STRIPPED, so a target's own
// prose about a symbol it no longer owns cannot satisfy a claim about its code. Precedent for the
// inversion: apps/core/.../leave/doc-accuracy.test.ts; for the SCANNED + length sentinel shape:
// apps/core/src/lib/tv/pitch-shift-doc-accuracy.test.ts.
//
// The package's production modules now live in domain subdirectories (core/, queue/, lyrics/,
// cook/, presentation/). The scan RECURSES so a subdir module is still covered, and a comment that
// cites a bare filename ("in separators.ts") resolves against a filename → path index so a pointer
// keeps resolving after its target moved subdir. This file itself stays at the package root.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = import.meta.dir; // packages/shared/src

// Every production .ts in this package, recursively (exclude tests and this guard's own subtree of
// nothing). Paths are relative to SRC (e.g. 'core/types.ts') so a new file — flat or nested — is
// scanned automatically.
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, ent.name);
		if (ent.isDirectory()) {
			out.push(...walk(abs));
		} else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
			out.push(relative(SRC, abs));
		}
	}
	return out;
}

const SCANNED = walk(SRC).sort();

// Bare filename → its relative path in the package. A comment cites `separators.ts`, not
// `lyrics/separators.ts`, so the resolver maps the basename to wherever the module now lives. A
// duplicate basename would be ambiguous; the package has none, and this asserts it below.
const byBasename = new Map<string, string>();
for (const rel of SCANNED) {
	const base = rel.split('/').pop()!;
	byBasename.set(base, rel);
}

// Blank comments (line + block) so the TARGET side is code-only; blank rather than delete so offsets
// and identifier boundaries are preserved.
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Comment text of a file (line-comment and block-comment lines only).
function commentText(src: string): string {
	return src
		.split('\n')
		.filter((l) => {
			const t = l.trim();
			return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
		})
		.join('\n');
}

type Pointer = { file: string; ident: string; target: string };

// A pointer is a backticked identifier followed, within the same comment window, by "in <file>.ts".
// Negated clauses ("rather than in", "instead of in", "not in") are the opposite claim — exclude them.
function extractPointers(file: string, comments: string): Pointer[] {
	const out: Pointer[] = [];
	const inRe = /\bin\s+([a-zA-Z0-9_-]+\.ts)\b/g;
	const identRe = /`([A-Za-z_]\w*)`/g;
	const negRe = /(rather than|instead of)\b|\bnot\b/i;
	for (const m of comments.matchAll(inRe)) {
		const target = m[1];
		if (target === undefined) continue;
		const start = m.index ?? 0;
		const window = comments.slice(Math.max(0, start - 120), start);
		const pre = comments.slice(Math.max(0, start - 25), start);
		if (negRe.test(pre)) continue; // negated clause — the opposite claim
		const idents = [...window.matchAll(identRe)].map((x) => x[1]).filter((x): x is string => x !== undefined);
		const ident = idents[idents.length - 1];
		if (ident === undefined) continue;
		out.push({ file, ident, target });
	}
	// de-dup identical (ident,target) within the file
	const seen = new Set<string>();
	return out.filter((p) => {
		const k = `${p.ident}\u0000${p.target}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

function allPointers(): Pointer[] {
	const all: Pointer[] = [];
	for (const f of SCANNED) {
		const src = readFileSync(join(SRC, f), 'utf8');
		all.push(...extractPointers(f, commentText(src)));
	}
	return all;
}

// The repo root, four levels up from packages/shared/src/... — well, three from SRC itself
// (src -> shared -> packages -> repo). Used only to tell a REAL cross-package citation (e.g.
// `hub.ts`, which lives at apps/core/src/server/realtime/hub.ts) apart from a stale or MISSPELLED
// in-package citation (e.g. `rotaton.ts`, a typo of rotation.ts, which exists nowhere). The domain
// regrouping moved modules into subdirs, so a citation that no longer resolves must still be
// caught — the earlier
// blanket "not a package module -> skip" arm let a misspelled package filename pass silently.
const REPO_ROOT = join(SRC, '..', '..', '..');

// Every .ts basename anywhere under apps/ and packages/ (excluding build output and node_modules).
// A cited filename present here is a real file somewhere in the repo — out of THIS guard's remit
// (it only checks in-package pointers) — so it is skipped. A cited filename present NOWHERE is a
// stale or misspelled citation and fails.
function walkBasenames(dir: string, out: Set<string>): void {
	let ents;
	try {
		ents = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of ents) {
		if (ent.name === 'node_modules' || ent.name === '.svelte-kit' || ent.name === 'build' || ent.name === 'dist' || ent.name === '.git') continue;
		const abs = join(dir, ent.name);
		if (ent.isDirectory()) walkBasenames(abs, out);
		else if (ent.name.endsWith('.ts')) out.add(ent.name);
	}
}
const repoTsBasenames = new Set<string>();
for (const top of ['apps', 'packages']) walkBasenames(join(REPO_ROOT, top), repoTsBasenames);

// Resolve a cited bare filename to its path anywhere in the package, then read its stripped code.
// Returns null when the cited file is not a scanned PACKAGE module. `resolves()` then decides: a name
// that exists elsewhere in the repo is a genuine cross-package pointer (skip); a name that exists
// nowhere is a stale/misspelled in-package citation (fail).
function targetCode(target: string): string | null {
	const rel = byBasename.get(target);
	if (rel === undefined) return null;
	return stripComments(readFileSync(join(SRC, rel), 'utf8'));
}

function resolves(p: Pointer): boolean {
	const code = targetCode(p.target);
	if (code === null) {
		// Not a package module. If the cited filename exists somewhere in the repo (e.g. `hub.ts` in
		// apps/core), it is a real cross-package reference and out of this guard's remit — skip. If it
		// exists nowhere, it is a stale or misspelled citation of the exact kind this guard exists for — fail.
		return repoTsBasenames.has(p.target);
	}
	return new RegExp(`\\b${p.ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code);
}

test('every in-file symbol pointer in a comment names the file whose CODE holds that symbol', () => {
	const pointers = allPointers();

	// ── non-vacuity sentinels: the machinery must actually be extracting and resolving. ──
	// (1) enough pointers extracted at all.
	expect(pointers.length, 'pointer extraction produced too few pointers').toBeGreaterThanOrEqual(5);
	// (1b) the scan recursed into the domain subdirs, so a nested module is covered.
	expect(SCANNED.some((f) => f.includes('/')), 'scan did not recurse into subdirectories').toBe(true);
	// (1c) no ambiguous duplicate basenames — the resolver assumes one path per filename.
	expect(byBasename.size, 'duplicate module basename would make citations ambiguous').toBe(SCANNED.length);
	// (2) the three known-true pointers still resolve (guards against a stripper/regex that resolves nothing).
	const known: Pointer[] = [
		{ file: 'lyrics/lyrics-engines.ts', ident: 'SeparatorCost', target: 'separators.ts' },
		{ file: 'core/settings.ts', ident: 'PlaybackState', target: 'types.ts' },
		{ file: 'presentation/tv-background.ts', ident: 'TV_VISUALIZERS', target: 'settings.ts' }
	];
	for (const k of known) {
		expect(resolves(k), `known-true pointer \`${k.ident}\` in ${k.target} unexpectedly failed to resolve`).toBe(true);
	}
	// (3) target anchors present after stripping (guards a stripper that blanks the whole file).
	expect(/\bSEPARATOR_ENGINES\b/.test(targetCode('separators.ts') ?? '')).toBe(true);
	expect(/\bresolveLyricsPresentation\b/.test(targetCode('settings.ts') ?? '')).toBe(true);
	// (4) the stripper actually removes comment prose: a planted comment naming a symbol its code lacks
	//     must NOT resolve.
	const planted = '// nonexistent __PLANTED_PROOF_SYMBOL__ appears only here in prose\n';
	expect(new RegExp('\\b__PLANTED_PROOF_SYMBOL__\\b').test(stripComments(planted))).toBe(false);
	// (5) the missing-in-package arm discriminates: a citation of a MISSPELLED package module
	//     (a name that exists nowhere in the repo) must FAIL, while a citation of a real cross-package
	//     file (`hub.ts`, in apps/core) is out of remit and must PASS. Without this the recursion's
	//     basename resolver would let `rotaton.ts` (a typo of rotation.ts) pass silently.
	expect(resolves({ file: 'core/ops.ts', ident: 'applyOp', target: 'rotaton.ts' }), 'a misspelled in-package citation must be caught, not skipped').toBe(false);
	expect(resolves({ file: 'core/ops.ts', ident: 'HubState', target: 'hub.ts' }), 'a real cross-package citation is out of remit and must be skipped').toBe(true);

	// ── the guard itself: no pointer may name a file whose code lacks the symbol. ──
	const offenders = pointers.filter((p) => !resolves(p)).map((p) => `${p.file}: \`${p.ident}\` claimed in ${p.target}`);
	expect(offenders, offenders.join(' | ')).toEqual([]);
});
