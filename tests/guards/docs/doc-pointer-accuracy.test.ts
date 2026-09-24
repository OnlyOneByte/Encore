// guard: a comment can point a reader to another file for a symbol ("`X` in `foo.ts`") and rot when that
// symbol MOVES file — `lyrics-engines.ts` named `tvProgressStyle` and `resolveLyricsPresentation` "in
// separators.ts" and both rotted when the config layer moved into `settings.ts`. Comment stripping is
// INVERTED on purpose: the SOURCE side is read as comment text while the TARGET side is comment-STRIPPED,
// so a target's own prose about a symbol it no longer owns cannot satisfy a claim about its code. The scan
// RECURSES into the domain subdirectories and resolves a bare filename through a basename index, so a
// pointer keeps resolving after its target moved subdir.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { at, repoRoot } from '@encore/test-support';

const SRC = at('src/lib/contract');

// Every production .ts in this package, recursively. Paths are relative to SRC (e.g. 'core/types.ts') so a
// new file — flat or nested — is scanned automatically.
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

// Bare filename → its relative path: a comment cites `separators.ts`, not `lyrics/separators.ts`. A
// duplicate basename would be ambiguous; the package has none, and this asserts it below.
const byBasename = new Map<string, string>();
for (const rel of SCANNED) {
	const base = rel.split('/').pop()!;
	byBasename.set(base, rel);
}

// Blank comments (line + block) so the TARGET side is code-only; blank rather than delete, so offsets and
// identifier boundaries survive.
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

// Used only to tell a REAL cross-tree citation (`hub.ts`, at src/lib/server/realtime/hub.ts) apart from a
// stale or MISSPELLED in-contract one (`rotaton.ts`, a typo of rotation.ts, which exists nowhere). WALK THE
// ROOT, never a list of top-level tree names: a hardcoded `['apps', 'packages']` went silently EMPTY when
// the `apps/` layer was flattened away — `walkBasenames` swallows a missing directory — and every
// cross-tree pointer then read as "exists nowhere" and failed.
const REPO_ROOT = repoRoot;

// Every .ts basename anywhere in the repo, excluding build output and node_modules. A cited filename
// present here is a real file somewhere and out of THIS guard's remit; one present NOWHERE is a stale or
// misspelled citation and fails.
function walkBasenames(dir: string, out: Set<string>): void {
	let ents;
	try {
		ents = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of ents) {
		if (
			ent.name === 'node_modules' ||
			ent.name === '.svelte-kit' ||
			ent.name === 'build' ||
			ent.name === 'dist' ||
			ent.name === '.git'
		)
			continue;
		const abs = join(dir, ent.name);
		if (ent.isDirectory()) walkBasenames(abs, out);
		else if (ent.name.endsWith('.ts')) out.add(ent.name);
	}
}
const repoTsBasenames = new Set<string>();
walkBasenames(REPO_ROOT, repoTsBasenames);

// Resolve a cited bare filename to its path in the contract and read its stripped code. Null when the
// cited file is not a scanned CONTRACT module; `resolves()` then decides skip versus fail.
function targetCode(target: string): string | null {
	const rel = byBasename.get(target);
	if (rel === undefined) return null;
	return stripComments(readFileSync(join(SRC, rel), 'utf8'));
}

function resolves(p: Pointer): boolean {
	const code = targetCode(p.target);
	if (code === null) {
		// Not a contract module: a filename existing elsewhere in the repo is a genuine cross-tree reference and
		// out of remit, while one existing nowhere is the stale or misspelled citation this guard catches.
		return repoTsBasenames.has(p.target);
	}
	return new RegExp(`\\b${p.ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code);
}

test('every in-file symbol pointer in a comment names the file whose CODE holds that symbol', () => {
	const pointers = allPointers();

	// Non-vacuity sentinels — the machinery must really be extracting and resolving. (1) enough pointers.
	expect(pointers.length, 'pointer extraction produced too few pointers').toBeGreaterThanOrEqual(5);
	// (1b) the scan recursed into the domain subdirs, so a nested module is covered.
	expect(
		SCANNED.some((f) => f.includes('/')),
		'scan did not recurse into subdirectories'
	).toBe(true);
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
	// (4) the stripper really removes prose: a planted comment naming a symbol its code lacks must not resolve.
	const planted = '// nonexistent __PLANTED_PROOF_SYMBOL__ appears only here in prose\n';
	expect(new RegExp('\\b__PLANTED_PROOF_SYMBOL__\\b').test(stripComments(planted))).toBe(false);
	// (5) the missing-in-contract arm discriminates: a MISSPELLED contract module (a name existing nowhere in
	//     the repo) must FAIL, while a real cross-tree file (`hub.ts`) is out of remit and must PASS. The pair
	//     is also the mutation arm for the repo-wide basename walk in both directions. The message is hoisted so
	//     the assertion FITS ON ONE LINE — a wrapped call moves the `@nvf-floor` tag off the `expect(` line.
	const walkNonVacuity =
		'the repo-wide basename walk found almost nothing, so every cross-tree citation would read as stale';
	expect(repoTsBasenames.size, walkNonVacuity).toBeGreaterThan(200); // @nvf-floor repoTsBasenames.size
	expect(
		resolves({ file: 'core/ops.ts', ident: 'applyOp', target: 'rotaton.ts' }),
		'a misspelled in-contract citation must be caught, not skipped'
	).toBe(false);
	expect(
		resolves({ file: 'core/ops.ts', ident: 'HubState', target: 'hub.ts' }),
		'a real cross-tree citation is out of remit and must be skipped'
	).toBe(true);

	// ── the guard itself: no pointer may name a file whose code lacks the symbol. ──
	const offenders = pointers.filter((p) => !resolves(p)).map((p) => `${p.file}: \`${p.ident}\` claimed in ${p.target}`);
	expect(offenders, offenders.join(' | ')).toEqual([]);
});
