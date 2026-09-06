// issue #433 — SOURCE-SCAN wiring guard for the worker-frame validation gate in apps/core/server.ts.
//
// WHY A SOURCE SCAN: the gate lives inside Bun.serve's `message(ws, raw)` closure. That closure is
// not exported and only runs with a live socket + full app wiring, so it has no unit harness — the
// exact file class the repo answers with a source scan reading production's own file (precedent:
// singers/session-cookie-attributes.test.ts, PR #107/#205; realtime/telemetry-frame-lean.test.ts).
// worker-frame-validation.test.ts pins validateWorkerMessage itself and mirrors the gate, but a mirror
// cannot prove server.ts CALLS it before the unguarded reads — that is the #224 gap. This guard closes
// it: it asserts the real server.ts imports the validator, runs it as a reject-gate, and does so BEFORE
// `'workerId' in msg` (the null-throw read) and before `app.workerHub.handle(` (the execute). Revert
// the gate hunk and this reds; a commented-out gate cannot satisfy it (comments are blanked first).
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Blank comments so a gate living only in a comment cannot satisfy the scan; blank (not delete) so
// offsets line up. Matches the repo stripComments convention, extended to // line comments (.ts).
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/jobs → three levels up to apps/core, then server.ts.
const SERVER = stripComments(readFileSync(join(import.meta.dir, '..', '..', '..', 'server.ts'), 'utf8'));

test('#433: server.ts imports validateWorkerMessage from worker-hub', () => {
	expect(SERVER).toMatch(/import\s*\{[^}]*\bvalidateWorkerMessage\b[^}]*\}\s*from\s*'\.\/src\/server\/jobs\/worker-hub'/);
});

test('#433: server.ts runs validateWorkerMessage as a reject-gate (non-null → return)', () => {
	// Pin the EXPRESSION, not a bare mention: a call whose non-null result short-circuits with return.
	expect(SERVER).toMatch(/if\s*\(\s*validateWorkerMessage\([^)]*\)\s*!==\s*null\s*\)\s*return\s*;/);
});

test('#433: the gate precedes both unguarded reads (workerId-in-msg and workerHub.handle)', () => {
	const gate = SERVER.search(/validateWorkerMessage\([^)]*\)\s*!==\s*null/);
	const workerIdRead = SERVER.search(/'workerId'\s+in\s+msg/);
	const execute = SERVER.search(/app\.workerHub\.handle\(/);
	expect(gate).toBeGreaterThanOrEqual(0);
	expect(workerIdRead).toBeGreaterThan(gate); // guard runs before the null-throw read
	expect(execute).toBeGreaterThan(gate); // guard runs before the execute
});
