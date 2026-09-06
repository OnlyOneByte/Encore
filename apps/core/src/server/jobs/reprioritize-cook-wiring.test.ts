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
	expect(SERVER).toMatch(/import\s*\{\s*reprioritizeCookForMedia\s*\}\s*from\s*'\.\/src\/server\/jobs\/reprioritize-cook'/);
});

test('server.ts wires HubDeps.onEntryAdded to reprioritizeCookForMedia (#179)', () => {
	// The add-side seam must be filled — an unwired onEntryAdded means the cook never gets un-starved.
	expect(SERVER).toMatch(/onEntryAdded:\s*\(mediaId,\s*entries\)\s*=>/);
	expect(SERVER).toMatch(/reprioritizeCookForMedia\(mediaId,\s*\{/);
});

test('the wired hook passes the job ledger, the post-add entries, and a dispatch kick (#179)', () => {
	// Without app.jobs it cannot find the outstanding cook; without dispatch() the un-stuck cook waits
	// for an unrelated trigger. Pin all three so a partial wiring is a red, not a silent regression.
	expect(SERVER).toMatch(/jobs:\s*app\.jobs/);
	expect(SERVER).toMatch(/entries,/);
	expect(SERVER).toMatch(/dispatch:\s*\(\)\s*=>\s*app\.workerHub\.dispatch\(\)/);
});
