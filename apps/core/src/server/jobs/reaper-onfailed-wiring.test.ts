// guard: the reaper-killed-cook gate fix (#90) is only real once app.ts WIRES the reaper's onFailed
// seam to settleGatesForFailedJob.
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

test('app.ts wires the JobReaper onFailed hook to settleGatesForFailedJob over mediaById (#90)', () => {
	// An unwired onFailed means a reaper-killed cook never settles its gate → readyToSing never flips
	// → rotation holds the queue entry forever. Pin the hook AND that it settles over the app's catalog
	// (settleGatesForFailedJob needs mediaById to reach the media), so a partial wiring is a red.
	expect(APP).toMatch(/onFailed:\s*\(job\)\s*=>\s*settleGatesForFailedJob\(job,\s*mediaById\)/);
});
