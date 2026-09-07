// guard: the reconnect-starvation fix (#135) is only real once server.ts WIRES the add seam.
//
// reprioritizeCookForMedia is unit-tested through the hub (reprioritize-cook.test.ts drives
// handleQueueCommand -> onEntryAdded -> the helper), but the seam it hangs on — HubDeps.onEntryAdded
// — is optional, and the LIVE composition that fills it lives inside the Bun.serve websocket message
// closure in apps/core/server.ts. That closure needs a live socket + full app wiring, so it has no
// unit harness (same file class as the session-cookie live writer, #107, and the autostart gate,
// #128). Reverting the wiring there leaves every hub test green, because they mirror the seam with a
// local onEntryAdded — so without this guard the fix could be silently unwired and ship green.
//
// WHY A SOURCE SCAN: the wiring is a decidable property of server.ts (does it pass
// reprioritizeCookForMedia to onEntryAdded, over app.jobs + app.workerHub.dispatch?), and there is
// no pure function to exercise instead. This asserts production's own text; comments are blanked so
// a commented-out wiring cannot satisfy it. Change the seam and this guard moves with it.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/jobs → three levels up to apps/core/server.ts.
const SERVER = stripComments(readFileSync(join(import.meta.dir, '..', '..', '..', 'server.ts'), 'utf8'));

test('server.ts imports reprioritizeCookForMedia (#179)', () => {
	expect(SERVER).toMatch(
		/import\s*\{\s*reprioritizeCookForMedia\s*\}\s*from\s*'\.\/src\/server\/jobs\/reprioritize-cook'/
	);
});

test('server.ts wires HubDeps.onEntryAdded to reprioritizeCookForMedia (#179)', () => {
	// The add-side seam must be filled — an unwired onEntryAdded means the cook never gets un-starved.
	expect(SERVER).toMatch(/onEntryAdded:\s*\(mediaId,\s*entries\)\s*=>/);
	expect(SERVER).toMatch(/reprioritizeCookForMedia\(mediaId,\s*\{/);
});

test('the wired hook passes the job ledger, the post-add entries, and a dispatch kick (#179)', () => {
	// Without app.jobs it cannot find the outstanding cook; without the *unfiltered* post-add entries
	// soonestSeqFor sees no queued turn and returns NO_QUEUE_PRIORITY (the cook stays starved); without
	// dispatch() the un-stuck cook waits for an unrelated trigger. Pin all three in ONE anchored match
	// over the whole call so a partial wiring — e.g. entries substituted by a filtered subset — reds,
	// not a silent regression. Three unanchored substring scans were vacuous here: /jobs:\s*app\.jobs/,
	// /entries,/ and /dispatch:.../ each also match unrelated call sites elsewhere in server.ts
	// (the onEntryRemoved cancelJobsForMedia wiring, upNextAfter(..., state.entries, ...), and the
	// /harness/phone dev-page <script> string), so the guard stayed 3/3 green with the hook mutated to
	// `entries: entries.filter((e) => e.status === 'playing')` — the exact type-valid partial that
	// restores the #135 starvation bug (#309). This mirrors reaper-onfailed-wiring.test.ts's single
	// anchored /onFailed:...settleGatesForFailedJob(job, mediaById)/.

	// Not-vacuous sentinel: the hook opening must be present, so a broken/empty read reds here first.
	expect(SERVER).toMatch(/onEntryAdded:\s*\(mediaId,\s*entries\)\s*=>\s*reprioritizeCookForMedia\(mediaId,\s*\{/);

	expect(SERVER).toMatch(
		/onEntryAdded:\s*\(mediaId,\s*entries\)\s*=>\s*reprioritizeCookForMedia\(mediaId,\s*\{\s*jobs:\s*app\.jobs,\s*entries,\s*now:[^,]+,\s*dispatch:\s*\(\)\s*=>\s*app\.workerHub\.dispatch\(\)\s*\}\)/
	);
});
