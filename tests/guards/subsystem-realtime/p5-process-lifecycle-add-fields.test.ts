// guard: the hub's add arm rejects a non-finite addedAt and any status !== 'queued', so an add frame missing
// them is refused outright. p5-process-lifecycle.mjs's queueViaWs minted three real QueueEntry fields plus
// two that are not fields at all, so every scenario in the probe died at setup on an op:reject. The frame
// must mint all SIX required fields. The probe has no unit harness, so its own source is the subject.
import { readFileSync } from 'node:fs';
import { test, expect } from 'bun:test';
import { at } from '@encore/test-support';
import { queueEntries } from '$lib/server/db/schema';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const PROBE_PATH = at('tests/e2e/probes/p5-process-lifecycle.mjs');
const PROBE = stripComments(readFileSync(PROBE_PATH, 'utf8'));

// Brace-match from queueViaWs's `op: 'add'` -> `entry: {` so the slice is exactly that literal, not a sibling
// helper's frame and not the surrounding command envelope.
function addEntryLiteral(src: string): string {
	const fn = src.indexOf('function queueViaWs');
	expect(fn).toBeGreaterThanOrEqual(0); // not vacuous: the function must exist
	const addOp = src.indexOf("op: 'add'", fn);
	expect(addOp).toBeGreaterThanOrEqual(0);
	const entryKey = src.indexOf('entry:', addOp);
	expect(entryKey).toBeGreaterThanOrEqual(0);
	const open = src.indexOf('{', entryKey);
	expect(open).toBeGreaterThanOrEqual(0);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return src.slice(open, i + 1);
		}
	}
	throw new Error('unbalanced braces: could not isolate the queueViaWs add entry literal');
}

const ENTRY = addEntryLiteral(PROBE);

// rotationSeq feeds a NOT NULL column and is re-stamped at the add seam, so it must still be on the wire.
const REQUIRED_FIELDS = ['id', 'mediaId', 'singerId', 'status', 'rotationSeq', 'addedAt'] as const;

test('the p5 queueViaWs add entry carries all six required QueueEntry fields', () => {
	// Not vacuous: the isolated literal must actually be the small entry object, not the whole file.
	expect(ENTRY.length).toBeGreaterThan(0);
	expect(ENTRY.length).toBeLessThan(400);
	for (const field of REQUIRED_FIELDS) {
		// Either KEY form: explicit `field:` or ES6 shorthand terminated by a comma or brace. One regex per
		// field so a dropped one reds with a message naming exactly which.
		expect(ENTRY).toMatch(new RegExp(`\\b${field}\\s*(?::|[,}])`));
	}
});

test('the status the p5 frame mints is a member of the queue_entries status enum', () => {
	// Checked against the column's own enum, so this guard tracks the schema rather than a hand-copied string.
	// 'queued' is the one value a client may mint.
	const m = ENTRY.match(/status\s*:\s*['"]([^'"]+)['"]/);
	expect(m).not.toBeNull();
	const status = m![1];
	expect(queueEntries.status.enumValues as readonly string[]).toContain(status);
	expect(status).toBe('queued');
});

test('the p5 add entry does NOT carry non-QueueEntry fields that only mislead', () => {
	// applyOp inserts op.entry verbatim and the six-column persistence mapping drops these, so they are noise
	// that masked the real gap.
	expect(ENTRY).not.toMatch(/\bsource\s*:/);
	expect(ENTRY).not.toMatch(/\brequestedBy\s*:/);
});
