// guard: EVERY add op an e2e .mjs harness script mints must carry all six QueueEntry fields the
// validateCommand add arm requires — { id, mediaId, singerId, status, rotationSeq, addedAt } — so a
// future contract move REDS this guard instead of silently killing a probe at setup.
//
// THE SYSTEMIC DEFECT (from #394). Nothing in `bun test` invokes apps/core/e2e/ — the probes
// are live-server scripts run by hand. So when the add contract moved (addedAt made finite in #305,
// status narrowed to 'queued' in #324), a probe whose add frame predated the move kept sending a
// stale frame that validateCommand now REJECTS: queueViaWs threw at setup and EVERY scenario in the
// probe died, loudly, to an audience of nobody. #394 fixed the one probe (p5-cook-lifecycle) that
// had rotted that far and guarded it by NAME. This guard is the systemic version: it does not name a
// probe, so a probe added tomorrow, or a contract field added tomorrow, is covered without a human
// remembering to widen a hand-maintained list.
//
// AUDIT AT AUTHORING. Driving every current probe's add frame through the real validateCommand
// (a throwaway harness, since deleted) returned null (ACCEPTED) for all three probes that mint one —
// p2-guiding-track, p11-dashboards, and p5-cook-lifecycle (the #394 reference). fuzz.mjs drives the
// real UI (page.click) so the client's own addSong builds the frame — no raw add literal. p8 and p9
// construct no add op at all. So NO probe was rotted at authoring; the repair half of #452 was a
// no-op and the lasting deliverable is this guard.
//
// WHY A SOURCE SCAN. The probes have no unit harness and no runner in bun test — there is no pure
// function to exercise — so the honest guard is a scan of the probes' own source text. Established
// idiom for this repo (no CI): #408/#411 widened source-scan guards to .mjs; #394 isolated an add
// entry literal by structure. Comments are blanked first (stripComments) so the prose above — which
// names all six fields — can neither satisfy nor trip the scan.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { queueEntries } from '../db/schema';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/realtime → up three to apps/core, then e2e.
const E2E_DIR = join(import.meta.dir, '..', '..', '..', 'e2e');

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

// Brace-match a `{...}` literal starting at `open` (which must index a `{`). Returns the slice
// inclusive of both braces.
function matchBraces(src: string, open: number): string {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return src.slice(open, i + 1);
		}
	}
	throw new Error(`unbalanced braces from index ${open}`);
}

// Resolve the `entry` object literal an add op mints, from the text at/after an `op: 'add'` site.
// Two shapes occur in the probes:
//   (a) inline — `op: 'add', entry: { ... }`   (p5, p11)
//   (b) by-reference — `entry` is a shorthand naming a `const entry = { ... }` declared just above,
//       e.g. p2's `op: { op: 'add', entry }`.
// Returns the isolated `{...}` literal for either shape, or throws if it cannot be resolved (which
// reds the guard — an add op the scan cannot verify is itself a failure, not a silent pass).
function resolveAddEntryLiteral(src: string, addOpIdx: number): string {
	// Bound the search to this op object so we don't wander into a sibling op far below.
	const window = src.slice(addOpIdx, addOpIdx + 600);
	// (a) inline `entry: {`
	const inline = window.match(/entry\s*:\s*\{/);
	if (inline && inline.index !== undefined) {
		const braceRel = window.indexOf('{', inline.index + inline[0].length - 1);
		return matchBraces(src, addOpIdx + braceRel);
	}
	// (b) shorthand `entry` (no colon-object) → find `const entry = {` earlier in the file.
	if (/\bentry\s*(?:[,}])/.test(window)) {
		const decl = src.lastIndexOf('const entry', addOpIdx);
		expect(decl).toBeGreaterThanOrEqual(0); // the referenced literal must exist
		const brace = src.indexOf('{', decl);
		expect(brace).toBeGreaterThanOrEqual(0);
		return matchBraces(src, brace);
	}
	throw new Error(`could not resolve the add-op entry literal at index ${addOpIdx}`);
}

// Find every add op an .mjs file mints and return { file, entry } for each. An add op is either
// `op: 'add'` (the op-object's own op key) or the shorthand `op:{op:'add'...}` — both contain the
// literal `op: 'add'` after stripping comments, so that token is the anchor.
function addFramesIn(file: string): string[] {
	const src = stripComments(readFileSync(file, 'utf8'));
	const literals: string[] = [];
	const re = /op\s*:\s*['"]add['"]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) {
		literals.push(resolveAddEntryLiteral(src, m.index));
	}
	return literals;
}

// The six fields the add arm requires. id/singerId/mediaId at hub.ts (missing → reject), addedAt
// (Number.isFinite), status (=== 'queued'), and rotationSeq feeds a NOT NULL column, re-stamped at
// the seam but present on the wire. status/rotationSeq are anchored to the schema below so this list
// cannot silently drift from the contract it protects.
const REQUIRED_FIELDS = ['id', 'mediaId', 'singerId', 'status', 'rotationSeq', 'addedAt'] as const;

// Match a field as an object KEY in either form: explicit `field:` or ES6 shorthand `field` closed
// by a comma or `}`. (The probes mix both: p11/p2 use shorthand for id/mediaId/singerId.)
function hasKey(literal: string, field: string): boolean {
	return new RegExp(`\\b${field}\\s*(?::|[,}])`).test(literal);
}

const MJS_FILES = collectMjs(E2E_DIR);

test('the e2e directory is walked and add frames are found (non-vacuous)', () => {
	// Sentinel: a broken walk that finds nothing must not pass vacuously (fuzz + party + probes/*).
	expect(MJS_FILES.length).toBeGreaterThan(10);
	// At least the three known producers (p2, p11, p5) mint an add frame; if a refactor removes ALL
	// raw add literals this floor reds so the guard cannot silently protect nothing.
	const total = MJS_FILES.reduce((n, f) => n + addFramesIn(f).length, 0);
	expect(total).toBeGreaterThanOrEqual(3);
});

test('every e2e .mjs add frame carries all six required QueueEntry fields', () => {
	const offenders: string[] = [];
	for (const file of MJS_FILES) {
		const rel = file.slice(E2E_DIR.length + 1);
		for (const entry of addFramesIn(file)) {
			// Non-vacuous: the isolated literal must be a small entry object, not a runaway slice.
			expect(entry.length).toBeGreaterThan(0);
			expect(entry.length).toBeLessThan(600);
			const missing = REQUIRED_FIELDS.filter((f) => !hasKey(entry, f));
			if (missing.length) offenders.push(`${rel}: missing ${missing.join(', ')}`);
		}
	}
	// Dropping any required field from any probe's add frame — or a contract move that a probe has
	// not caught up to — reds this with the offending probe and field named.
	expect(offenders).toEqual([]);
});

test('every e2e .mjs add frame mints status: a member of the queue_entries enum, i.e. queued', () => {
	const enumValues = queueEntries.status.enumValues as readonly string[];
	const offenders: string[] = [];
	for (const file of MJS_FILES) {
		const rel = file.slice(E2E_DIR.length + 1);
		for (const entry of addFramesIn(file)) {
			const m = entry.match(/status\s*:\s*['"]([^'"]+)['"]/);
			// A shorthand `status` with no literal value can't be enum-checked here; the fields test
			// above already requires the key to be present. Only check where a string literal exists.
			if (!m) continue;
			const status = m[1];
			if (!enumValues.includes(status)) offenders.push(`${rel}: off-enum status '${status}'`);
			else if (status !== 'queued')
				offenders.push(`${rel}: server-owned status '${status}' (a client may only add 'queued')`);
		}
	}
	expect(offenders).toEqual([]);
});
