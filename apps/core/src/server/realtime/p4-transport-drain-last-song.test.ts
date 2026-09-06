// guard: the p4-transport probe's SINGLE-COOKED-SONG arm must DRAIN every queued turn before it
// asserts "no current entry", not issue one skip and assert (#264).
//
// THE DEFECT (#264): p4-transport.mjs takes its `else` arm when only ONE song was COOKED
// (secondReadyId === null). The count of COOKED media and the count of QUEUED turns are different
// things — a room can hold one cooked song yet several waiting turns on it (a second singer's turn,
// or an entry left behind by an interrupted earlier run). The old arm issued exactly ONE
// clickByLabel('skip') and then asserted currentEntryId === null (T6a, CRITICAL) plus, downstream,
// that the transport controls are disabled (T5a/b/c, HIGH). With an extra queued turn, one skip
// advances INTO it — the correct rotation per apps/core/src/server/realtime/player.ts advance() —
// so currentEntryId stays set and isPlaying stays true. All four assertions then fire as PHANTOMS
// against a room that behaved correctly, and the CRITICAL costs a maintainer a full triage cycle.
//
// THE FIX: the arm now runs the same drain loop the multi-cooked arm already uses — repeatedly read
// currentEntryId, break when it is null, else skip — so "skip the LAST song" is genuinely the last
// song regardless of how many turns are queued, and the T5 precondition (queue empty, nothing
// playing) is actually established. A genuinely stuck room (advance that never reaches null) still
// reds T6a because the loop exits with currentEntryId still set.
//
// WHY A SOURCE SCAN: the probe is a live-server .mjs script with no unit harness — there is no pure
// function to exercise. This asserts the probe's own control-flow text. Comments are blanked so the
// explanatory prose above the arm (which describes both the OLD single-skip mistake and the NEW
// drain) can neither satisfy nor trip the check. Reverting the arm to a single skip reds this guard.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/realtime → up three to apps/core, then e2e/probes.
const PROBE_PATH = join(import.meta.dir, '..', '..', '..', 'e2e', 'probes', 'p4-transport.mjs');
const PROBE = stripComments(readFileSync(PROBE_PATH, 'utf8'));

// Capture the `else` arm body: from the `} else {` that opens the single-cooked-song branch up to
// the matching close `}` that precedes the T5 section. We locate the branch by its unique T6a record
// text ("skip on the sole (last) song"), then walk back to the `} else {` and forward with a brace
// depth counter to the matching close so the slice is exactly the arm, not the whole file.
function elseArmBody(src: string): string {
	const t6a = src.indexOf("skip on the sole (last) song");
	expect(t6a).toBeGreaterThanOrEqual(0); // not vacuous: the arm's T6a record must exist
	const elseOpen = src.lastIndexOf('} else {', t6a);
	expect(elseOpen).toBeGreaterThanOrEqual(0);
	// depth starts at 1 for the `{` in `} else {`; walk to the matching close.
	let depth = 0;
	let i = elseOpen + '} else '.length; // points at the opening `{`
	const start = i + 1;
	for (; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return src.slice(start, i);
		}
	}
	throw new Error('unbalanced braces: could not find the end of the else arm');
}

const ARM = elseArmBody(PROBE);

test('the single-cooked-song arm exists and contains the T6a no-current assertion (#264, not vacuous)', () => {
	expect(ARM).toContain("skip on the sole (last) song");
	expect(ARM).toMatch(/currentEntryId\s*===\s*null/);
});

test('the single-cooked-song arm drains the queue with a skip LOOP before asserting no-current (#264)', () => {
	// A drain loop: a `for` that reads currentEntryId, breaks when it is null, and skips otherwise.
	// One arm alone would leave a room with an extra queued turn still current after the assertion.
	expect(ARM).toMatch(/for\s*\([^)]*\)\s*\{[\s\S]*currentEntryId[\s\S]*break[\s\S]*clickByLabel\(\s*['"]skip['"]\s*\)[\s\S]*\}/);
});

test('the single-cooked-song arm does NOT skip exactly once before asserting (#264 regression trap)', () => {
	// The old shape was a bare `await phone1.clickByLabel('skip')` immediately followed by
	// readServerPlayback + the T6a assert, with NO surrounding loop. Assert the skip that precedes
	// the assertion is inside a loop by requiring the loop keyword to appear before the T6a record
	// within this arm.
	const loopIdx = ARM.search(/for\s*\(/);
	const t6aIdx = ARM.indexOf("skip on the sole (last) song");
	expect(loopIdx).toBeGreaterThanOrEqual(0);
	expect(t6aIdx).toBeGreaterThanOrEqual(0);
	expect(loopIdx).toBeLessThan(t6aIdx);
});
