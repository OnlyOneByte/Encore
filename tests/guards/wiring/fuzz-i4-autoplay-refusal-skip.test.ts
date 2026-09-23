// `checkI4` must SKIP under a gestureless autoplay refusal BEFORE it judges the lyrics highlight against
// the playhead. fuzz.mjs runs gestureless by default, so the browser refuses autoplay and the master sits
// paused at t=0 with only its preload burst decoded while the server says isPlaying and the reel advances
// off the server intent. Caught: with no skip, I4 compared `cue = currentTime + LEAD_SEC` against a frozen
// playhead and filed a PHANTOM violation on every gestureless run, so the seams it exists to reach were
// never reached. It must STILL BITE with the master genuinely decoding — a blanket disable is a vacuous pass.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/** Blank comments, so the prose describing the defect cannot satisfy or trip a check. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const PROBE = stripComments(read('tests/e2e/fuzz.mjs'));

/** checkI4's body by brace balance, so the slice is not the whole file or a first-`}` truncation. */
function checkI4Body(src: string): string {
	const decl = src.indexOf('async function checkI4(w');
	expect(decl).toBeGreaterThanOrEqual(0); // checkI4 must exist
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
	// The skip must not have deleted I4's ability to bite: the cue-vs-window judgement stays.
	expect(BODY).toMatch(/const\s+cue\s*=\s*w\.master\.currentTime\s*\+\s*LEAD_SEC/);
	expect(BODY).toMatch(/the lyrics highlight is on a line whose window does not contain the playhead/);
});

test('checkI4 skips under a gestureless autoplay refusal', () => {
	// A skip(), not a violation, and it must carry the refusal reason.
	expect(BODY).toMatch(/if\s*\(\s*autoplayRefused\(w\)\s*\)/);
	expect(BODY).toMatch(/skip\(\s*[\s\S]*?'I4'[\s\S]*?the browser refused autoplay/);
});

test('checkI4 skips a refused master BEFORE it computes the cue (regression trap)', () => {
	// ORDERING: the cue-vs-window compare is what produces the phantom, so a skip placed after it never
	// fires.
	const skipIdx = BODY.search(/autoplayRefused\(w\)/);
	const cueIdx = BODY.search(/const\s+cue\s*=\s*w\.master\.currentTime/);
	expect(skipIdx).toBeGreaterThanOrEqual(0);
	expect(cueIdx).toBeGreaterThanOrEqual(0);
	expect(skipIdx).toBeLessThan(cueIdx);
});
