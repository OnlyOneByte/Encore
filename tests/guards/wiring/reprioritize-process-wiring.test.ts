// guard: the reconnect-starvation fix is only real once server.ts WIRES the add seam.
//
// reprioritizeProcessForMedia is unit-tested through the hub (reprioritize-process.test.ts drives
// handleQueueCommand -> onEntryAdded -> the helper), but the seam it hangs on — HubDeps.onEntryAdded
// — is optional, and the LIVE composition that fills it now lives in app.ts's buildHubDeps factory
// (a later refactor folded the per-frame bag into one factory; before that this wiring was in the Bun.serve
// websocket message closure in server.ts). The hub tests mirror the seam with a local onEntryAdded,
// so reverting the real wiring leaves them green — without this guard the fix could be silently
// unwired and ship green.
//
// WHY A SOURCE SCAN: the wiring is a decidable property of the factory (does buildHubDeps pass
// reprioritizeProcessForMedia to onEntryAdded, over app.jobs + app.workerHub.dispatch?), and there is
// no pure function to exercise instead. This asserts production's own text; comments are blanked so
// a commented-out wiring cannot satisfy it. Change the seam and this guard moves with it — which is
// exactly what happened here when the seam moved from server.ts into the factory.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// app.ts named explicitly — where buildHubDeps (the single HubDeps composition site) wires this seam.
// The old form was `at('src/lib/server/app.ts')`, which meant this file only while the guard
// sat in src/lib/server/jobs.
const APP = stripComments(read('src/lib/server/app.ts'));

test('app.ts imports reprioritizeProcessForMedia', () => {
	expect(APP).toMatch(/import\s*\{\s*reprioritizeProcessForMedia\s*\}\s*from\s*'\.\/jobs\/reprioritize-process'/);
});

test('app.ts buildHubDeps wires HubDeps.onEntryAdded to reprioritizeProcessForMedia', () => {
	// The add-side seam must be filled — an unwired onEntryAdded means the process never gets un-starved.
	// Params carry type annotations in the factory (mediaId: string, entries: QueueEntry[]).
	expect(APP).toMatch(/onEntryAdded:\s*\(mediaId(?::\s*string)?,\s*entries(?::\s*QueueEntry\[\])?\)\s*=>/);
	expect(APP).toMatch(/reprioritizeProcessForMedia\(mediaId,\s*\{/);
});

test('the wired hook passes the job ledger, the post-add entries, and a dispatch kick', () => {
	// Without app.jobs it cannot find the outstanding process; without the *unfiltered* post-add entries
	// soonestSeqFor sees no queued turn and returns NO_QUEUE_PRIORITY (the process stays starved); without
	// dispatch() the un-stuck process waits for an unrelated trigger. Pin all three in ONE anchored match
	// over the whole call so a partial wiring — e.g. entries substituted by a filtered subset — reds,
	// not a silent regression. Three unanchored substring scans were vacuous here: /jobs:\s*app\.jobs/,
	// /entries,/ and /dispatch:.../ each also match unrelated call sites elsewhere in server.ts
	// (the onEntryRemoved cancelJobsForMedia wiring, upNextAfter(..., state.entries, ...), and the
	// /harness/phone dev-page <script> string), so the guard stayed 3/3 green with the hook mutated to
	// `entries: entries.filter((e) => e.status === 'playing')` — the exact type-valid partial that
	// restores the starvation bug. This mirrors reaper-onfailed-wiring.test.ts's single
	// anchored /onFailed:...settleGatesForFailedJob(job, mediaById)/.

	// Not-vacuous sentinel: the hook opening must be present, so a broken/empty read reds here first.
	expect(APP).toMatch(
		/onEntryAdded:\s*\(mediaId(?::\s*string)?,\s*entries(?::\s*QueueEntry\[\])?\)\s*=>\s*reprioritizeProcessForMedia\(mediaId,\s*\{/
	);

	expect(APP).toMatch(
		/onEntryAdded:\s*\(mediaId(?::\s*string)?,\s*entries(?::\s*QueueEntry\[\])?\)\s*=>\s*reprioritizeProcessForMedia\(mediaId,\s*\{\s*jobs:\s*app\.jobs,\s*entries,\s*now:[^,]+,\s*dispatch:\s*\(\)\s*=>\s*app\.workerHub\.dispatch\(\)\s*\}\)/
	);
});
