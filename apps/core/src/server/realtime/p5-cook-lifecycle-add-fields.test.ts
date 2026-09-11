// guard: the p5-cook-lifecycle probe's queueViaWs add op must mint ALL SIX QueueEntry fields the
// validateCommand add arm requires, so the probe's scenarios reach the cook-lifecycle behaviour
// they exist to check instead of dying at setup on an op:reject.
//
// THE DEFECT: queueViaWs (apps/core/e2e/probes/p5-cook-lifecycle.mjs) built its add-op entry
// as { id, mediaId, singerId, source: 'phone', requestedBy: 'guest' } — three real QueueEntry
// fields plus two that are NOT QueueEntry fields at all. It was missing addedAt, status and
// rotationSeq. hub.ts's add arm rejects a non-finite addedAt ('invalid addedAt', :164) and any
// status !== 'queued' ('invalid status', :165), so the frame was refused and queueViaWs threw
// `queue add rejected: ...` at :201 — every scenario in the probe died at setup. The two other add
// producers in e2e/ (p2-guiding-track.mjs, p11-dashboards.mjs) both mint all six and are accepted;
// only p5 was stale. The addedAt guard and the status narrowing both landed
// AFTER queueViaWs was written, so the frame silently rotted.
//
// WHY A SOURCE SCAN: the probe is a live-server .mjs script with no unit harness and no runner in
// bun test — there is no pure function to exercise, so nothing behavioural can pin it. This asserts
// the probe's own source: we isolate the add-op `entry` object literal by structure and require
// each of the six field NAMES to appear as a key in it. Comments are blanked first so the
// docstring above the function (which now NAMES the six fields in prose) can neither satisfy nor
// trip the check. Dropping any required key from the literal reds this guard.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { queueEntries } from '../db/schema';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/realtime → up three to apps/core, then e2e/probes.
const PROBE_PATH = join(import.meta.dir, '..', '..', '..', 'e2e', 'probes', 'p5-cook-lifecycle.mjs');
const PROBE = stripComments(readFileSync(PROBE_PATH, 'utf8'));

// Isolate the object literal passed as the add op's `entry` inside queueViaWs. We locate the
// function by name, then the first `op: 'add'` after it, then the `entry: {` that follows, and
// brace-match to the closing `}` so the slice is exactly that literal — not a sibling helper's
// frame and not the surrounding command envelope.
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

// The six fields the add arm requires. id/singerId/mediaId are checked at hub.ts:107-112,
// addedAt at :164, status at :165, and rotationSeq feeds a NOT NULL column re-stamped at the seam
// (hub.ts :257-263) so it must be present on the wire. Kept as an explicit list — the cross-check
// test below anchors status/rotationSeq to the schema so this list cannot silently drift.
const REQUIRED_FIELDS = ['id', 'mediaId', 'singerId', 'status', 'rotationSeq', 'addedAt'] as const;

test('the p5 queueViaWs add entry carries all six required QueueEntry fields', () => {
	// Not vacuous: the isolated literal must actually be the small entry object, not the whole file.
	expect(ENTRY.length).toBeGreaterThan(0);
	expect(ENTRY.length).toBeLessThan(400);
	for (const field of REQUIRED_FIELDS) {
		// Match the field as an object KEY in EITHER form: an explicit `field:` value, or ES6
		// shorthand `field` terminated by a comma or the closing brace (the p5 literal writes
		// id/mediaId/singerId shorthand and status/rotationSeq/addedAt explicit). A regex per field
		// so a dropped field reds with a message naming exactly which one is missing.
		expect(ENTRY).toMatch(new RegExp(`\\b${field}\\s*(?::|[,}])`));
	}
});

test('the status the p5 frame mints is a member of the queue_entries status enum', () => {
	// The add arm demands status === 'queued' specifically; assert the literal mints a member of the
	// column's own enum (source of truth), so this guard tracks the schema rather than a hand-copied
	// string. 'queued' is the one value a client may mint (hub.ts :165).
	const m = ENTRY.match(/status\s*:\s*['"]([^'"]+)['"]/);
	expect(m).not.toBeNull();
	const status = m![1];
	expect(queueEntries.status.enumValues as readonly string[]).toContain(status);
	expect(status).toBe('queued');
});

test('the p5 add entry does NOT carry non-QueueEntry fields that only mislead', () => {
	// source / requestedBy are not QueueEntry fields — applyOp inserts op.entry verbatim and the
	// six-column persistence mapping drops them, so their presence in the frame is pure noise that
	// masked the real gap. Keep the frame to the schema's own fields.
	expect(ENTRY).not.toMatch(/\bsource\s*:/);
	expect(ENTRY).not.toMatch(/\brequestedBy\s*:/);
});
