// Every add op an e2e .mjs harness mints must carry all six QueueEntry fields the `validateCommand` add
// arm requires. Nothing in `bun test` invokes tests/e2e/, so when the add contract moved, probes with a
// stale add frame were REJECTED at setup and every scenario in them died to an audience of nobody. The
// scan names no probe, so a probe or a required field added tomorrow is covered with no list to widen.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { queueEntries } from '$lib/server/db/schema';
import { e2eDir } from '@encore/test-support';

/** Blank comments in place, so this file's own list of the six fields cannot satisfy or trip the scan. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

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

/** Brace-match the `{...}` literal at `open`, returning the slice inclusive of both braces. */
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

/**
 * Isolate the `entry` literal an add op mints. Probes write it two ways: inline as `entry: { … }`, or by
 * reference as a shorthand `entry` naming a `const entry = { … }` above. THROWS when neither resolves —
 * an add op the scan cannot verify must red the guard, not pass silently.
 */
function resolveAddEntryLiteral(src: string, addOpIdx: number): string {
	// Bounded so the search cannot wander into a sibling op far below.
	const window = src.slice(addOpIdx, addOpIdx + 600);
	const inline = window.match(/entry\s*:\s*\{/);
	if (inline && inline.index !== undefined) {
		const braceRel = window.indexOf('{', inline.index + inline[0].length - 1);
		return matchBraces(src, addOpIdx + braceRel);
	}
	if (/\bentry\s*(?:[,}])/.test(window)) {
		const decl = src.lastIndexOf('const entry', addOpIdx);
		expect(decl).toBeGreaterThanOrEqual(0); // the referenced literal must exist
		const brace = src.indexOf('{', decl);
		expect(brace).toBeGreaterThanOrEqual(0);
		return matchBraces(src, brace);
	}
	throw new Error(`could not resolve the add-op entry literal at index ${addOpIdx}`);
}

/** Every add op in one .mjs file. Both op spellings contain the literal `op: 'add'`, so it is the anchor. */
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

// Why these six: hub.ts rejects a missing id/singerId/mediaId, addedAt must be `Number.isFinite`,
// status must be `'queued'`, and rotationSeq feeds a NOT NULL column — re-stamped at the seam, but
// required on the wire. The status arm below re-reads the schema so the list cannot drift silently.
const REQUIRED_FIELDS = ['id', 'mediaId', 'singerId', 'status', 'rotationSeq', 'addedAt'] as const;

/** A field as an object KEY in either form: explicit `field:` or ES6 shorthand, which probes mix. */
function hasKey(literal: string, field: string): boolean {
	return new RegExp(`\\b${field}\\s*(?::|[,}])`).test(literal);
}

const MJS_FILES = collectMjs(E2E_DIR);

test('the e2e directory is walked and add frames are found (non-vacuous)', () => {
	// A broken walk that finds nothing must not pass vacuously.
	expect(MJS_FILES.length).toBeGreaterThan(10);
	// Three probes mint a raw add literal; a refactor that removes all of them reds here rather than
	// leaving the guard silently protecting nothing.
	const total = MJS_FILES.reduce((n, f) => n + addFramesIn(f).length, 0);
	expect(total).toBeGreaterThanOrEqual(3);
});

test('every e2e .mjs add frame carries all six required QueueEntry fields', () => {
	const offenders: string[] = [];
	for (const file of MJS_FILES) {
		const rel = file.slice(E2E_DIR.length + 1);
		for (const entry of addFramesIn(file)) {
			// The isolated literal must be a small entry object, not a runaway slice.
			expect(entry.length).toBeGreaterThan(0);
			expect(entry.length).toBeLessThan(600);
			const missing = REQUIRED_FIELDS.filter((f) => !hasKey(entry, f));
			if (missing.length) offenders.push(`${rel}: missing ${missing.join(', ')}`);
		}
	}
	expect(offenders).toEqual([]);
});

test('every e2e .mjs add frame mints status: a member of the queue_entries enum, i.e. queued', () => {
	const enumValues = queueEntries.status.enumValues as readonly string[];
	const offenders: string[] = [];
	for (const file of MJS_FILES) {
		const rel = file.slice(E2E_DIR.length + 1);
		for (const entry of addFramesIn(file)) {
			const m = entry.match(/status\s*:\s*['"]([^'"]+)['"]/);
			// A shorthand `status` carries no literal to enum-check; the arm above already requires the key.
			if (!m) continue;
			const status = m[1];
			if (!enumValues.includes(status)) offenders.push(`${rel}: off-enum status '${status}'`);
			else if (status !== 'queued')
				offenders.push(`${rel}: server-owned status '${status}' (a client may only add 'queued')`);
		}
	}
	expect(offenders).toEqual([]);
});
