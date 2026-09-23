// The fuzz driver's gestureless policy must be complete about the GESTURE, not just the
// --autoplay-policy flag. Three defects with one root cause: `autoplayRefused` keyed on
// `currentTime === 0`, so a gestureless `seek` moved the playhead off 0 on a still-blocked master and
// checkI6 filed a PHANTOM CRITICAL on a healthy tree; `realClick` was never called, so the TV never
// started and I4/I6 evaluated nothing while the run printed green; and the I6 report hardcoded a
// frozen-at-0 server position that contradicted the non-zero value interpolated beside it.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

/** Blank comments, so the prose describing the defect cannot satisfy or trip a check. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const PROBE_PATH = at('tests/e2e/fuzz.mjs');
const RAW = readFileSync(PROBE_PATH, 'utf8');
const PROBE = stripComments(RAW);

/** A named function's body by brace balance, so a match cannot come from a first-`}` truncation. */
function fnBody(src: string, declStr: string): string {
	const decl = src.indexOf(declStr);
	expect(decl).toBeGreaterThanOrEqual(0);
	const open = src.indexOf('{', decl);
	expect(open).toBeGreaterThanOrEqual(0);
	let depth = 0;
	const start = open + 1;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return src.slice(start, i);
		}
	}
	throw new Error(`unbalanced braces: could not find the end of ${declStr}`);
}

const REFUSED_BODY = fnBody(PROBE, 'function autoplayRefused(w)');

test('A · autoplayRefused no longer keys on currentTime === 0 (a seek defeated it)', () => {
	// The honest predicate for an un-started TV is the DECODER at its preload floor, not the playhead at 0.
	expect(REFUSED_BODY).not.toMatch(/currentTime\s*===\s*0/);
	expect(REFUSED_BODY).toMatch(/atPreloadFloor\(w\)/);
	// Still gated on the gestureless policy and a paused master.
	expect(REFUSED_BODY).toMatch(/!AUTOPLAY/);
	expect(REFUSED_BODY).toMatch(/paused\s*===\s*true/);
});

test('B · the driver delivers the real gesture the CDP tap helper made available (realClick was absent)', () => {
	expect(PROBE).toMatch(/\brealClick\(/);
	// Delivered through the dedicated helper and recorded as a real-tap step, so a replay is faithful.
	expect(PROBE).toMatch(/maybeDeliverTap/);
	expect(PROBE).toMatch(/real-tap/);
});

test('B · a run that never evaluated I6 exits 2, never 0 — the non-vacuity floor', () => {
	// A run that never fired I6 measured nothing about audio and must not report green.
	expect(PROBE).toMatch(/stats\.I6\.checked\s*===\s*0/);
	// The floor must GUARD the green summary path rather than replace it, so exit 2 follows it.
	const floorIdx = PROBE.search(/stats\.I6\.checked\s*===\s*0/);
	const region = PROBE.slice(floorIdx, floorIdx + 400);
	expect(region).toMatch(/exitCode\s*=\s*2/);
});

test('C · the I6 silent-room report interpolates the server position, not a hardcoded 0', () => {
	const I6_BODY = fnBody(PROBE, 'async function checkI6(w)');
	expect(I6_BODY).not.toMatch(/server position frozen at 0/);
	// It must still name the server position, by interpolating it.
	expect(I6_BODY).toMatch(/positionSec/);
});
