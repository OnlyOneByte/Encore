// guard: the reaper-killed-cook fix is only real once app.ts WIRES the reaper's onFailed seam.
// #90 settled the readiness gate; #303 makes the same hook also REPORT (broadcast media:status,
// log one line, reclaim scratch) so a reaper-killed cook is not silent; #451 collapses that whole
// four-step epilogue — which was open-coded at THREE sites plus a fourth copy in a test — into ONE
// exported function, reportTerminalFailure, called from all three. This guard moved WITH the seam:
// its original header ("Change the seam and this guard moves") anticipated exactly this.
//
// TWO decidable properties are pinned by source scan, because both live where there is no pure
// function to exercise:
//   1. app.ts's getApp() builds the JobReaper with an onFailed that DELEGATES to reportTerminalFailure
//      over the app's mediaById + publish. getApp() stands up the whole app and has no unit harness,
//      and reaper.test.ts supplies its OWN onFailed — so reverting app.ts's wiring leaves every reaper
//      test green. Without this scan the fix could be silently unwired and ship green (the exact class
//      of bug that let #303's reaper path ship silent).
//   2. reportTerminalFailure itself (make-karaoke.ts) still performs all FOUR epilogue steps. The
//      behavioural test reaper-broadcast-on-failure.test.ts drives it end-to-end, but a step guarded
//      behind a dead branch or reordered after an early return can still pass a broadcast-only
//      assertion; pinning the function's text closes that.
//
// Comments are blanked so a commented-out wiring cannot satisfy any match.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/jobs → one level up to app.ts, same dir for make-karaoke.
const APP = stripComments(readFileSync(join(import.meta.dir, '..', 'app.ts'), 'utf8'));
const MK = stripComments(readFileSync(join(import.meta.dir, 'make-karaoke.ts'), 'utf8'));

test('app.ts imports reportTerminalFailure — the one shared terminal-fail epilogue', () => {
	expect(APP).toMatch(/import\s*\{[^}]*\breportTerminalFailure\b[^}]*\}\s*from\s*'\.\/jobs\/make-karaoke'/);
});

test('app.ts wires the JobReaper onFailed hook through reportTerminalFailure over mediaById + publish', () => {
	// An unwired onFailed means a reaper-killed cook never settles its gate → readyToSing never flips
	// → rotation holds the queue entry forever (#90), AND stays silent. Isolate the onFailed
	// hook and pin that it delegates to the shared epilogue with the reaper cause and both deps.
	const start = APP.indexOf('onFailed:');
	expect(start).toBeGreaterThanOrEqual(0);
	// The hook body runs to the next top-level close of the reaper-options object. Capture from
	// onFailed: to the JobReaper construction's closing — a generous window that still cannot pick up
	// unrelated code because reportTerminalFailure(job, 'reaper', ...) is unique to this seam.
	const hook = APP.slice(start, start + 400);
	// Delegates to the ONE shared epilogue, with the reaper cause discriminator.
	expect(hook).toMatch(/reportTerminalFailure\(\s*job,\s*'reaper'/);
	// Passes the app's catalog (mediaById) and a broadcast sink routed through the room publisher.
	expect(hook).toMatch(/broadcast:\s*\(e\)\s*=>\s*app\.publish\(e\)/);
	expect(hook).toMatch(/mediaById/);
	// A partial wiring that dropped the whole hook must red: the whole-file scan backstops the window.
	expect(APP).toMatch(/onFailed:\s*\(job\)\s*=>\s*reportTerminalFailure\(job,\s*'reaper'/);
});

test('reportTerminalFailure performs all four terminal-fail epilogue steps', () => {
	// Isolate the function body so a match cannot be satisfied by unrelated make-karaoke.ts code.
	const sig = MK.indexOf('export function reportTerminalFailure');
	expect(sig).toBeGreaterThanOrEqual(0);
	const open = MK.indexOf('{', sig);
	expect(open).toBeGreaterThanOrEqual(0);
	let depth = 0,
		end = -1;
	for (let i = open; i < MK.length; i++) {
		if (MK[i] === '{') depth++;
		else if (MK[i] === '}') {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	expect(end).toBeGreaterThan(open);
	const fn = MK.slice(open, end + 1);
	// (1) settle the #90 gate — the epilogue's first act, so the previously-working half cannot be
	//     dropped or dead-wrapped while the room-facing half still broadcasts.
	const fnBody = fn.slice(fn.indexOf('{') + 1);
	expect(fnBody).toMatch(/^\s*const\s+settled\s*=\s*settleGatesForFailedJob\(job,\s*deps\.mediaById\);/);
	// (2) broadcast media:status via mediaStatusFor, gated on shouldBroadcastCook, ordered after settle.
	expect(fn).toMatch(/shouldBroadcastCook\(job,\s*media\)/);
	expect(fn).toMatch(/type:\s*'media:status'/);
	expect(fn).toMatch(/status:\s*mediaStatusFor\(job\)/);
	const settleIdx = fn.indexOf('settleGatesForFailedJob');
	const branchIdx = fn.indexOf('shouldBroadcastCook');
	expect(settleIdx).toBeGreaterThanOrEqual(0);
	expect(branchIdx).toBeGreaterThan(settleIdx);
	// (3) one operator log line, in the uniform key=value format so a single grep finds every path.
	expect(fn).toMatch(/console\.warn\(/);
	expect(fn).toMatch(/cause=\$\{cause\}/);
	expect(fn).toMatch(/job=\$\{job\.id\}/);
	expect(fn).toMatch(/media=\$\{job\.mediaId\}/);
	expect(fn).toMatch(/attempts=\$\{job\.attempts\}/);
	expect(fn).toMatch(/reason=/);
	// (4) reclaim the job's scratch — the step the TTL branch used to omit.
	expect(fn).toMatch(/cleanJobWork\(job\.id\)/);
});
