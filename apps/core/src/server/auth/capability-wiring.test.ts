// capabilities.ts:1 calls itself "the ONE place that answers 'is this actor allowed to do that?'" and
// :9-11 promises that gating any capability later is "an edit HERE and nowhere else". For two of the
// five capabilities that promise was false: `queue:remove-any` and `queue:reorder-any` had NO asker —
// the queue's remove/move ops were gated by membership only (hub.ts's actorSingerId check) and never
// consulted can(). So narrowing can() to add a host gate would silently leave remove/reorder open to
// every joined singer, exactly the operations those two capabilities were named for (issue #106).
//
// There is nothing to assert BEHAVIOURALLY today: can() returns Boolean(actor?.singerId), so with the
// wiring in place remove/move still succeed for any joined singer (Angelo's "every joined singer is a
// host" ruling). The regression is a MISSING CALL SITE, so the guard is a source-level assertion that
// hub.ts's validateCommand GATES each op through can() with the capability it is named for — the
// `if (!can(...)) return` guard shape, not merely a call whose result is discarded (an inert call would
// re-open the bug the moment can() is narrowed). Deleting or defanging either gate reds the matching
// assertion; that is the mutation proof.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const hubSrc = readFileSync(
	fileURLToPath(new URL('../realtime/hub.ts', import.meta.url)),
	'utf-8'
);

// Isolate validateCommand's body so a can() call elsewhere in the file (a future handler) cannot
// satisfy the guard on the remove/move ops' behalf.
function validateCommandBody(src: string): string {
	const start = src.indexOf('export function validateCommand');
	expect(start).toBeGreaterThan(-1);
	// The next top-level `export function` after it bounds the body.
	const rest = src.slice(start + 1);
	const nextExport = rest.indexOf('\nexport function');
	return nextExport === -1 ? src.slice(start) : src.slice(start, start + 1 + nextExport);
}

test('validateCommand gates queue:remove-any through can() — its named asker exists', () => {
	const body = validateCommandBody(hubSrc);
	// The remove op must consult the capability gate, not membership alone.
	expect(body).toMatch(/if\s*\(\s*!can\(\s*\{\s*singerId:\s*deps\.actorSingerId\s*\}\s*,\s*'queue:remove-any'\s*\)\s*\)\s*return/);
});

test('validateCommand gates queue:reorder-any through can() — its named asker exists', () => {
	const body = validateCommandBody(hubSrc);
	expect(body).toMatch(/if\s*\(\s*!can\(\s*\{\s*singerId:\s*deps\.actorSingerId\s*\}\s*,\s*'queue:reorder-any'\s*\)\s*\)\s*return/);
});

test('hub imports can from the capabilities module (the ONE decision point)', () => {
	expect(hubSrc).toMatch(/import\s*\{\s*can\s*\}\s*from\s*'\.\.\/auth\/capabilities'/);
});
