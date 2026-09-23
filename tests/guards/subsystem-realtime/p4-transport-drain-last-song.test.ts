// The count of PROCESSED media and the count of QUEUED turns are different things: a room can hold one
// processed song yet several waiting turns on it. Caught: p4-transport.mjs's single-processed-song arm issued
// ONE skip and then asserted currentEntryId === null, so an extra queued turn made one skip advance INTO it
// (correct rotation per player.ts advance()) and fired four PHANTOM failures, one CRITICAL, against a room that
// behaved correctly. The arm must DRAIN every queued turn — skip until currentEntryId reads null — before
// asserting, which also establishes the T5 precondition that nothing is playing.
//
// The probe is a live-server .mjs script with no unit harness, so its own control-flow text is the subject.
// Comments are blanked, since the prose above the arm describes both the old single-skip and the new drain.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const PROBE_PATH = at('tests/e2e/probes/p4-transport.mjs');
const PROBE = stripComments(readFileSync(PROBE_PATH, 'utf8'));

// Locate the single-processed-song branch by its unique T6a record text, walk back to the `} else {`, then
// brace-match forward, so the slice is exactly that arm rather than the whole file.
function elseArmBody(src: string): string {
	const t6a = src.indexOf('skip on the sole (last) song');
	expect(t6a).toBeGreaterThanOrEqual(0); // not vacuous: the arm's T6a record must exist
	const elseOpen = src.lastIndexOf('} else {', t6a);
	expect(elseOpen).toBeGreaterThanOrEqual(0);
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

// Resolve the drain by STRUCTURE — the arm's own loop, else the body of the single helper it awaits — because
// the drain may legally be hoisted into a helper (the multi-processed arm runs the same one). Pinning "a
// for-loop token sits in the arm" fails both ways: it survives a loop whose break is inverted so it drains
// NOTHING, and it falsely reds a correct helper extraction.
function drainBody(arm: string, whole: string): string {
	// Case 1: the drain loop is inline in the arm.
	const forIdx = arm.search(/for\s*\(/);
	if (forIdx >= 0) {
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
	// Case 2: no inline loop — follow the awaited names to the one whose declaration holds the skip loop.
	const calls = [...arm.matchAll(/await\s+([A-Za-z_$][\w$]*)\s*\(/g)]
		.map((m) => m[1])
		.filter((n) => !['sleep'].includes(n));
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
	// Not vacuous: the resolved drain body must actually skip and read the playhead.
	expect(DRAIN).toMatch(/clickByLabel\(\s*['"]skip['"]\s*\)/);
	expect(DRAIN).toMatch(/currentEntryId/);
	// Break on the EXHAUSTED condition — `if (!<id>) break` — so it keeps skipping until the room is empty.
	expect(DRAIN).toMatch(/if\s*\(\s*!\s*[A-Za-z_$][\w$]*\s*\)\s*break/);
});

test('the single-processed-song drain does NOT break while an entry is still current (false-safety trap)', () => {
	// Inverting the break to `if (<id>) break` keeps the loop's SHAPE but drains NOTHING: it exits on the first
	// iteration whenever an entry is current, which is the very state the loop exists to clear.
	expect(DRAIN).not.toMatch(/if\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*break/);
});

// Mirrors drainBody()'s Case 1 / Case 2 split but returns the drain's start index WITHIN the arm, which is a
// distinct property from "a drain exists": a real drain placed AFTER the T6a assertion still asserts against an
// undrained room and ships green.
function drainStartInArm(arm: string): number {
	// Case 1: inline `for` loop in the arm — its position IS the drain's position.
	const forIdx = arm.search(/for\s*\(/);
	if (forIdx >= 0) return forIdx;
	// Case 2: hoisted into a helper — the arm's AWAIT CALL-SITE is where it runs.
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
	expect(drainIdx).toBeLessThan(t6aIdx);
});
