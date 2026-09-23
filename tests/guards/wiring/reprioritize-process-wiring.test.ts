// `HubDeps.onEntryAdded` is OPTIONAL, and the live composition that fills it is `buildHubDeps` in app.ts.
// The hub tests mirror the seam with a local `onEntryAdded`, so reverting the real wiring leaves them
// green while a queued process stays starved forever.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/** Blank comments, so a commented-out wiring line cannot satisfy a match. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const APP = stripComments(read('src/lib/server/app.ts'));

test('app.ts imports reprioritizeProcessForMedia', () => {
	expect(APP).toMatch(/import\s*\{\s*reprioritizeProcessForMedia\s*\}\s*from\s*'\.\/jobs\/reprioritize-process'/);
});

test('app.ts buildHubDeps wires HubDeps.onEntryAdded to reprioritizeProcessForMedia', () => {
	// Annotations are optional in the pattern because the factory spells the param types and a closure
	// elsewhere may not.
	expect(APP).toMatch(/onEntryAdded:\s*\(mediaId(?::\s*string)?,\s*entries(?::\s*QueueEntry\[\])?\)\s*=>/);
	expect(APP).toMatch(/reprioritizeProcessForMedia\(mediaId,\s*\{/);
});

test('the wired hook passes the job ledger, the post-add entries, and a dispatch kick', () => {
	// All three deps in ONE anchored match over the whole call. Unanchored substring scans were vacuous
	// here — `jobs: app.jobs`, `entries,` and `dispatch:` each also match unrelated call sites — and stayed
	// green with `entries` substituted by `entries.filter((e) => e.status === 'playing')`, the type-valid
	// partial that restores the bug: without app.jobs the outstanding process is not found, without the
	// UNFILTERED post-add entries `soonestSeqFor` sees no queued turn and returns NO_QUEUE_PRIORITY, and
	// without dispatch() the un-stuck process waits for an unrelated trigger.

	// The hook opening must be present, so a broken or empty read reds here first.
	expect(APP).toMatch(
		/onEntryAdded:\s*\(mediaId(?::\s*string)?,\s*entries(?::\s*QueueEntry\[\])?\)\s*=>\s*reprioritizeProcessForMedia\(mediaId,\s*\{/
	);

	expect(APP).toMatch(
		/onEntryAdded:\s*\(mediaId(?::\s*string)?,\s*entries(?::\s*QueueEntry\[\])?\)\s*=>\s*reprioritizeProcessForMedia\(mediaId,\s*\{\s*jobs:\s*app\.jobs,\s*entries,\s*now:[^,]+,\s*dispatch:\s*\(\)\s*=>\s*app\.workerHub\.dispatch\(\)\s*\}\)/
	);
});
