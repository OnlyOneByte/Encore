// guard: the p4-transport probe's SINGLE-PROCESSED-SONG arm must DRAIN every queued turn before it
// asserts "no current entry", not issue one skip and assert.
//
// THE DEFECT: p4-transport.mjs takes its `else` arm when only ONE song was PROCESSED
// (secondReadyId === null). The count of PROCESSED media and the count of QUEUED turns are different
// things — a room can hold one processed song yet several waiting turns on it (a second singer's turn,
// or an entry left behind by an interrupted earlier run). The old arm issued exactly ONE
// clickByLabel('skip') and then asserted currentEntryId === null (T6a, CRITICAL) plus, downstream,
// that the transport controls are disabled (T5a/b/c, HIGH). With an extra queued turn, one skip
// advances INTO it — the correct rotation per src/lib/server/realtime/player.ts advance() —
// so currentEntryId stays set and isPlaying stays true. All four assertions then fire as PHANTOMS
// against a room that behaved correctly, and the CRITICAL costs a maintainer a full triage cycle.
//
// THE FIX: the arm now runs the same drain loop the multi-processed arm already uses — repeatedly read
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
import { at } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Paths come from `at()`, which resolves against the repo root, so this guard does not encode its own depth.
const PROBE_PATH = at('tests/e2e/probes/p4-transport.mjs');
const PROBE = stripComments(readFileSync(PROBE_PATH, 'utf8'));

// Capture the `else` arm body: from the `} else {` that opens the single-processed-song branch up to
// the matching close `}` that precedes the T5 section. We locate the branch by its unique T6a record
// text ("skip on the sole (last) song"), then walk back to the `} else {` and forward with a brace
// depth counter to the matching close so the slice is exactly the arm, not the whole file.
function elseArmBody(src: string): string {
	const t6a = src.indexOf('skip on the sole (last) song');
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

test('the single-processed-song arm exists and contains the T6a no-current assertion (not vacuous)', () => {
	expect(ARM).toContain('skip on the sole (last) song');
	expect(ARM).toMatch(/currentEntryId\s*===\s*null/);
});

// Resolve the code that ACTUALLY drains the queue in the single-processed arm, wherever it lives.
// The drain may be written inline as a `for` loop in the arm, OR hoisted into a helper the arm
// calls (a legal refactor — the multi-processed arm runs the same drain, so factoring it out is the
// obvious next edit and changes no behaviour). Pinning "a for-loop token sits in the arm" is wrong
// on both faces: it survives a loop whose break is inverted so it drains NOTHING (verbatim,
// reached by a one-character edit), and it falsely reds a correct helper extraction. So we find the
// drain body by structure — the arm's own loop if it has one, else the body of the single helper it
// awaits — and assert the DRAIN SEMANTICS: it reads currentEntryId, clicks skip, and breaks on the
// EXHAUSTED condition (`if (!id) break`), never on the PRESENT condition (`if (id) break`, which
// exits on the first still-current entry and drains nothing).
function drainBody(arm: string, whole: string): string {
	// Case 1: the drain loop is inline in the arm.
	const forIdx = arm.search(/for\s*\(/);
	if (forIdx >= 0) {
		// brace-match from the loop's opening `{`.
		const open = arm.indexOf('{', forIdx);
		expect(open).toBeGreaterThanOrEqual(0);
		let depth = 0;
		for (let i = open; i < arm.length; i++) {
			const c = arm[i];
			if (c === '{') depth++;
			else if (c === '}') {
				depth--;
				if (depth === 0) return arm.slice(open + 1, i);
			}
		}
		throw new Error('unbalanced braces in the arm drain loop');
	}
	// Case 2: no inline loop — the arm must call exactly one helper; follow it to its declaration.
	const calls = [...arm.matchAll(/await\s+([A-Za-z_$][\w$]*)\s*\(/g)]
		.map((m) => m[1])
		// clickByLabel/readServerPlayback/sleep are not drains; the drain helper is a distinct name.
		.filter((n) => !['sleep'].includes(n));
	// Among the awaited names, find the one whose declaration contains a skip loop.
	for (const name of calls) {
		const decl = new RegExp(
			`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`
		);
		const dm = whole.match(decl);
		if (!dm || dm.index === undefined) continue;
		const open = whole.indexOf('{', dm.index + dm[0].length - 1);
		if (open < 0) continue;
		let depth = 0;
		for (let i = open; i < whole.length; i++) {
			const c = whole[i];
			if (c === '{') depth++;
			else if (c === '}') {
				depth--;
				if (depth === 0) {
					const body = whole.slice(open + 1, i);
					if (/clickByLabel\(\s*['"]skip['"]\s*\)/.test(body)) return body;
					break;
				}
			}
		}
	}
	throw new Error('single-processed arm has neither an inline drain loop nor a resolvable drain helper');
}

const DRAIN = drainBody(ARM, PROBE);

test('the single-processed-song arm DRAINS the queue: reads currentEntryId, skips, breaks when empty', () => {
	// Not vacuous: the drain body we resolved must actually skip and read the playhead.
	expect(DRAIN).toMatch(/clickByLabel\(\s*['"]skip['"]\s*\)/);
	expect(DRAIN).toMatch(/currentEntryId/);
	// The loop must break on the EXHAUSTED condition — `if (!<id>) break` — so it keeps skipping
	// until the room is empty. This is the invariant requires: "skip the LAST song" means the
	// queue is genuinely drained, not one skip issued.
	expect(DRAIN).toMatch(/if\s*\(\s*!\s*[A-Za-z_$][\w$]*\s*\)\s*break/);
});

test('the single-processed-song drain does NOT break while an entry is still current (false-safety trap)', () => {
	// M5: inverting the break to `if (<id>) break` keeps the loop's SHAPE but drains NOTHING — it
	// exits on the first iteration whenever an entry is current, which is exactly the state the loop
	// exists to clear. currentEntryId is then still set at the T6a assertion and fires verbatim.
	// A break guarded by the bare (present) condition, with no negation, is the defect; ban it.
	expect(DRAIN).not.toMatch(/if\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*break/);
});

// Resolve WHERE the drain sits inside the arm, so we can pin its ORDER relative to the T6a assert.
// Mirrors drainBody()'s Case 1 / Case 2 split, but returns the drain's start index WITHIN the arm
// (Case 1: the inline `for`; Case 2: the arm's call-site of the drain helper) rather than its body.
// This is a distinct property from "a drain exists": is produced by the compare that FOLLOWS
// the drain, so a real drain placed AFTER the T6a assertion still asserts against an undrained room
// and ships back green (the direction PR left unpinned). Precedent: / pinned the
// skip's index < the measurement's index as a separate property from the skip existing.
function drainStartInArm(arm: string): number {
	// Case 1: inline `for` loop lives in the arm — its position IS the drain's position.
	const forIdx = arm.search(/for\s*\(/);
	if (forIdx >= 0) return forIdx;
	// Case 2: the drain is hoisted into a helper — the arm's AWAIT CALL-SITE is where it runs. Find
	// the awaited name whose declaration is the skip loop (same resolution drainBody() uses), then
	// return the index of that await in the arm.
	const calls = [...arm.matchAll(/await\s+([A-Za-z_$][\w$]*)\s*\(/g)].filter((m) => m[1] !== 'sleep');
	for (const m of calls) {
		const name = m[1];
		const decl = new RegExp(
			`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`
		);
		const dm = PROBE.match(decl);
		if (!dm || dm.index === undefined) continue;
		const open = PROBE.indexOf('{', dm.index + dm[0].length - 1);
		if (open < 0) continue;
		let depth = 0;
		for (let i = open; i < PROBE.length; i++) {
			const c = PROBE[i];
			if (c === '{') depth++;
			else if (c === '}') {
				depth--;
				if (depth === 0) {
					const body = PROBE.slice(open + 1, i);
					if (/clickByLabel\(\s*['"]skip['"]\s*\)/.test(body)) return m.index ?? -1;
					break;
				}
			}
		}
	}
	throw new Error('could not locate the drain in the single-processed arm to pin its order');
}

test('the single-processed-song arm DRAINS BEFORE it asserts no-current (order — the ship-a-bug direction)', () => {
	const drainIdx = drainStartInArm(ARM);
	const t6aIdx = ARM.indexOf('skip on the sole (last) song');
	// Not vacuous: both anchors must resolve inside the arm.
	expect(drainIdx).toBeGreaterThanOrEqual(0);
	expect(t6aIdx).toBeGreaterThanOrEqual(0);
	// The drain MUST run before the T6a assertion. A real drain placed AFTER T6a leaves every
	// earlier test green (a drain still exists, still breaks on empty) yet asserts currentEntryId
	// against an UNDRAINED room — verbatim. This assertion is the one that reds that move.
	expect(drainIdx).toBeLessThan(t6aIdx);
});
