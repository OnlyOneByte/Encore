// #622 — a comment can point a reader to another file for a symbol ("`X` in `foo.ts`") and rot when
// that symbol MOVES file. Symbol naming (#581) does not protect a cross-file pointer: `lyrics-engines.ts`
// named `tvProgressStyle` and `resolveLyricsPresentation` "in separators.ts" by symbol, and both rotted
// when `0addb65` moved the config layer into `settings.ts`. Same class as #567's rotted citations.
//
// Comment stripping is INVERTED on purpose: the defect lives IN the source comments, so the SOURCE side
// is read as comment text (never stripped) while the TARGET side is comment-STRIPPED, so a target's own
// prose about a symbol it no longer owns cannot satisfy a claim about its code. Precedent for the
// inversion: apps/core/.../leave/doc-accuracy.test.ts; for the SCANNED + length sentinel shape:
// apps/core/src/lib/tv/pitch-shift-doc-accuracy.test.ts (PR #580).
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = import.meta.dir; // packages/shared/src

// Every production .ts in this package (exclude tests). Dynamic so a new file is scanned automatically.
const SCANNED = readdirSync(SRC)
	.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
	.sort();

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

function targetCode(target: string): string {
	return stripComments(readFileSync(join(SRC, target), 'utf8'));
}

function resolves(p: Pointer): boolean {
	const code = targetCode(p.target);
	return new RegExp(`\\b${p.ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code);
}

test('every in-file symbol pointer in a comment names the file whose CODE holds that symbol', () => {
	const pointers = allPointers();

	// ── non-vacuity sentinels: the machinery must actually be extracting and resolving. ──
	// (1) enough pointers extracted at all.
	expect(pointers.length, 'pointer extraction produced too few pointers').toBeGreaterThanOrEqual(5);
	// (2) the three known-true pointers still resolve (guards against a stripper/regex that resolves nothing).
	const known: Pointer[] = [
		{ file: 'lyrics-engines.ts', ident: 'SeparatorCost', target: 'separators.ts' },
		{ file: 'settings.ts', ident: 'PlaybackState', target: 'types.ts' },
		{ file: 'tv-background.ts', ident: 'TV_VISUALIZERS', target: 'settings.ts' }
	];
	for (const k of known) {
		expect(resolves(k), `known-true pointer \`${k.ident}\` in ${k.target} unexpectedly failed to resolve`).toBe(true);
	}
	// (3) target anchors present after stripping (guards a stripper that blanks the whole file).
	expect(/\bSEPARATOR_ENGINES\b/.test(targetCode('separators.ts'))).toBe(true);
	expect(/\bresolveLyricsPresentation\b/.test(targetCode('settings.ts'))).toBe(true);
	// (4) the stripper actually removes comment prose: a planted comment naming a symbol its code lacks
	//     must NOT resolve.
	const planted = '// nonexistent __PLANTED_PROOF_SYMBOL__ appears only here in prose\n';
	expect(new RegExp('\\b__PLANTED_PROOF_SYMBOL__\\b').test(stripComments(planted))).toBe(false);

	// ── the guard itself: no pointer may name a file whose code lacks the symbol. ──
	const offenders = pointers.filter((p) => !resolves(p)).map((p) => `${p.file}: \`${p.ident}\` claimed in ${p.target}`);
	expect(offenders, offenders.join(' | ')).toEqual([]);
});
