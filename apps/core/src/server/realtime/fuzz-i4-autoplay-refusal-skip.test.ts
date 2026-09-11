// guard: the fuzz driver's checkI4 must SKIP under a gestureless autoplay refusal (master paused at
// t=0, preload burst only) before it judges the lyrics highlight against the playhead.
//
// THE DEFECT: e2e/fuzz.mjs runs gestureless by default (--autoplay-policy is deliberately OFF,
// "without the flag this is a television; with it, it is not"). In that state the browser refuses
// autoplay and the master sits paused at currentTime=0 with only its preload burst decoded, while the
// server says isPlaying and the reel advances off the server intent. checkI4 had no skip for that
// state, so it computed `cue = master.currentTime + LEAD_SEC` against a frozen playhead and reported
// the reel's legitimate position as a violation at input #4 of every gestureless run — a PHANTOM the
// #64 full-screen tap-to-start affordance keeps off screen for any real viewer. The adjacency seams
// the file exists to reach were never reached. Its sibling checkI6 already had this skip; the file
// header (fuzz.mjs:46-48) claims I1/I4/I6 all skip under this policy — I1 and I6 did, I4 did not.
//
// THE FIX: a shared autoplayRefused(w) helper (!AUTOPLAY && master paused && currentTime === 0) skips
// I4 with the refusal reason named, exactly as I6 does. The check must STILL BITE: with the master
// genuinely decoding (autoplay granted, or after a real gesture) the cue-vs-window violation remains,
// so a blanket disable of I4 — the vacuous pass fuzz.mjs:47 warns about — is NOT what shipped.
//
// WHY A SOURCE SCAN: fuzz.mjs is a live-server .mjs invoked by nothing in `bun test` — no unit
// harness, no pure function to exercise. This asserts the probe's own control-flow text. Comments are
// blanked so the prose describing the defect cannot satisfy or trip the check. Reverting the skip out
// of checkI4 reds this guard.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/realtime → up three to apps/core, then e2e/fuzz.mjs.
const PROBE_PATH = join(import.meta.dir, '..', '..', '..', 'e2e', 'fuzz.mjs');
const PROBE = stripComments(readFileSync(PROBE_PATH, 'utf8'));

// Capture the body of `async function checkI4(w) { ... }`: locate the unique declaration, walk to its
// opening `{`, then advance with a brace-depth counter to the matching close so the slice is exactly
// checkI4's body and not the whole file or a first-`}` truncation.
function checkI4Body(src: string): string {
	const decl = src.indexOf('async function checkI4(w');
	expect(decl).toBeGreaterThanOrEqual(0); // not vacuous: checkI4 must exist
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
	throw new Error('unbalanced braces: could not find the end of checkI4');
}

const BODY = checkI4Body(PROBE);

test('checkI4 exists and still computes the cue-vs-window judgement (not vacuous)', () => {
	// The load-bearing judgement must still be present — the fix skips a refused master, it does NOT
	// delete I4's ability to bite. cue = playhead + LEAD_SEC, compared against the line window.
	expect(BODY).toMatch(/const\s+cue\s*=\s*w\.master\.currentTime\s*\+\s*LEAD_SEC/);
	expect(BODY).toMatch(/the lyrics highlight is on a line whose window does not contain the playhead/);
});

test('checkI4 skips under a gestureless autoplay refusal', () => {
	// The skip must be present and must be a skip() (not a violation) carrying the refusal reason.
	expect(BODY).toMatch(/if\s*\(\s*autoplayRefused\(w\)\s*\)/);
	expect(BODY).toMatch(/skip\(\s*[\s\S]*?'I4'[\s\S]*?the browser refused autoplay/);
});

test('checkI4 skips a refused master BEFORE it computes the cue (#331 regression trap)', () => {
	// If the skip landed AFTER the cue computation it would never fire — the phantom violation is
	// produced by the cue-vs-window compare. Require the autoplayRefused guard to precede the cue.
	const skipIdx = BODY.search(/autoplayRefused\(w\)/);
	const cueIdx = BODY.search(/const\s+cue\s*=\s*w\.master\.currentTime/);
	expect(skipIdx).toBeGreaterThanOrEqual(0);
	expect(cueIdx).toBeGreaterThanOrEqual(0);
	expect(skipIdx).toBeLessThan(cueIdx);
});
