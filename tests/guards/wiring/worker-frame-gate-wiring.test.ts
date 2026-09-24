// The worker-frame validation gate lives inside Bun.serve's unexported `message(ws, raw)` closure, so it
// has no unit harness. `worker-frame-validation.test.ts` pins `validateWorkerMessage` itself and MIRRORS
// the gate, but a mirror cannot prove server.ts calls it before the unguarded reads — which is the gap
// this closes.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const SERVER = stripComments(read('server.ts'));

test('server.ts imports validateWorkerMessage from worker-hub', () => {
	expect(SERVER).toMatch(
		/import\s*\{[^}]*\bvalidateWorkerMessage\b[^}]*\}\s*from\s*'\.\/src\/lib\/server\/jobs\/worker-hub'/
	);
});

test('server.ts runs validateWorkerMessage as a reject-gate (non-null → return)', () => {
	// The EXPRESSION, not a bare mention: a NON-NULL result must short-circuit with return, since the
	// validator answers null for a valid frame.
	expect(SERVER).toMatch(/if\s*\(\s*validateWorkerMessage\([^)]*\)\s*!==\s*null\s*\)\s*return\s*;/);
});

test('the gate precedes both unguarded reads (workerId-in-msg and workerHub.handle)', () => {
	const gate = SERVER.search(/validateWorkerMessage\([^)]*\)\s*!==\s*null/);
	const workerIdRead = SERVER.search(/'workerId'\s+in\s+msg/);
	const execute = SERVER.search(/app\.workerHub\.handle\(/);
	expect(gate).toBeGreaterThanOrEqual(0);
	expect(workerIdRead).toBeGreaterThan(gate); // before the null-throw read
	expect(execute).toBeGreaterThan(gate); // before the execute
});
