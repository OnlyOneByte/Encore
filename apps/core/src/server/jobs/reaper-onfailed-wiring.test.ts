// guard: the reaper-killed-cook fix is only real once app.ts WIRES the reaper's onFailed seam.
// #90 settled the readiness gate; #303 makes the same hook also REPORT (broadcast media:status,
// log one line, reclaim scratch) so a reaper-killed cook is not silent. This guard moved WITH the
// seam — its own header (below) anticipated exactly this ("Change the seam and this guard moves").
//
// settleGatesForFailedJob is exercised directly (reaper.test.ts constructs a real JobReaper with
// onFailed wired to it and drives attempts to exhaustion), but the LIVE composition that fills the
// seam lives inside getApp() in apps/core/src/server/app.ts — the reaper is built there with a
// closure over the app's mediaById, and getApp() has no unit harness (it stands up the whole app).
// Reverting the wiring there leaves every reaper test green, because they supply their own onFailed —
// so without this guard the fix could be silently unwired and ship green.
//
// WHY A SOURCE SCAN: the wiring is a decidable property of app.ts (does the JobReaper it builds pass
// an onFailed that calls settleGatesForFailedJob over mediaById?), and there is no pure function to
// exercise instead. This asserts production's own text; comments are blanked so a commented-out
// wiring cannot satisfy it. Change the seam and this guard moves with it.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/jobs → two levels up to apps/core/src/server/app.ts.
const APP = stripComments(readFileSync(join(import.meta.dir, '..', 'app.ts'), 'utf8'));

test('app.ts imports settleGatesForFailedJob (#90)', () => {
	expect(APP).toMatch(/import\s*\{[^}]*\bsettleGatesForFailedJob\b[^}]*\}\s*from\s*'\.\/jobs\/make-karaoke'/);
});

test('app.ts imports the media-status helpers and cleanJobWork the reaper hook needs (#303)', () => {
	// The reporting half broadcasts via mediaStatusFor gated on shouldBroadcastCook and reclaims
	// scratch via cleanJobWork; missing any import unwires the fix at compile time.
	expect(APP).toMatch(/import\s*\{[^}]*\bmediaStatusFor\b[^}]*\bshouldBroadcastCook\b[^}]*\}\s*from\s*'\.\/jobs\/media-status'/);
	expect(APP).toMatch(/import\s*\{[^}]*\bcleanJobWork\b[^}]*\}\s*from\s*'\.\/media\/migrate-layout'/);
});

test('app.ts wires the JobReaper onFailed hook to a block that settles the gate over mediaById (#90)', () => {
	// An unwired onFailed means a reaper-killed cook never settles its gate → readyToSing never flips
	// → rotation holds the queue entry forever. The hook is now a BLOCK body (it also reports, #303),
	// so pin the block form AND that it settles over the app's catalog. A partial wiring is a red.
	expect(APP).toMatch(/onFailed:\s*\(job\)\s*=>\s*\{/);
	expect(APP).toMatch(/settleGatesForFailedJob\(job,\s*mediaById\)/);
});

test('app.ts reaper onFailed hook also REPORTS a reaper-killed cook (#303)', () => {
	// #90 settled the gate but the hook did NOTHING else: no media:status, no log, no scratch reclaim,
	// so the watching phone stayed pinned on "Making karaoke…" forever. Pin all three reporting acts,
	// gated on shouldBroadcastCook so a background stems-upgrade cannot regress a ready row.
	// Isolate the onFailed hook body so these matches cannot be satisfied by unrelated app.ts code.
	const start = APP.indexOf('onFailed:');
	expect(start).toBeGreaterThanOrEqual(0);
	// Walk from the block open to its matching close with a brace-depth counter.
	const open = APP.indexOf('{', start);
	expect(open).toBeGreaterThanOrEqual(0);
	let depth = 0, end = -1;
	for (let i = open; i < APP.length; i++) {
		if (APP[i] === '{') depth++;
		else if (APP[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
	}
	expect(end).toBeGreaterThan(open);
	const hook = APP.slice(open, end + 1);
	// (a) settle the #90 gate — pinned as the UNCONDITIONAL FIRST statement of the hook body. The
	//     split assertion in the test above only proves the text exists SOMEWHERE in app.ts, which both
	//     relocation (settle moved inside the broadcast branch) and dead-wrapping (`if (false) settle;`)
	//     defeat while the whole suite stays green — reopening #90's exact defect (readyToSing never
	//     flips, rotation holds the queue entry forever). Reconstructing the binding the old single
	//     regex `onFailed: (job) => settleGatesForFailedJob(job, mediaById)` carried in one pattern.
	//     `hookBody` is the stripped-comment body between the braces; requiring the settle to be the
	//     first statement rules out any `if (...)`/`const ...` appearing before it, so the settle is
	//     provably unconditional and first (ordering-first also means a throw in the reporting steps
	//     cannot regress the previously-working #90 half).
	const hookBody = hook.slice(hook.indexOf('{') + 1);
	expect(hookBody).toMatch(/^\s*settleGatesForFailedJob\(job,\s*mediaById\);/);
	// Defense in depth: it is also strictly before the broadcast branch (redundant given first-statement
	// but pins order explicitly, the technique used in p4-transport-drain-last-song.test.ts).
	const settleIdx = hook.indexOf('settleGatesForFailedJob');
	const branchIdx = hook.indexOf('if (shouldBroadcastCook');
	expect(settleIdx).toBeGreaterThanOrEqual(0);
	expect(branchIdx).toBeGreaterThanOrEqual(0);
	expect(settleIdx).toBeLessThan(branchIdx);
	// (b) broadcast media:status via mediaStatusFor, gated on shouldBroadcastCook
	expect(hook).toMatch(/shouldBroadcastCook\(job,\s*media\)/);
	expect(hook).toMatch(/type:\s*'media:status'/);
	expect(hook).toMatch(/status:\s*mediaStatusFor\(job\)/);
	// (c) one operator log line
	expect(hook).toMatch(/console\.warn\(/);
	// (d) reclaim the job's scratch
	expect(hook).toMatch(/cleanJobWork\(job\.id\)/);
});
