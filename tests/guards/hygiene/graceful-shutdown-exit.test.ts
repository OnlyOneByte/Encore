// guard: a graceful shutdown whose state flush FAILED must exit NON-ZERO.
//
// THE DEFECT. server.ts's gracefulShutdown() caught an error from state.flushNow()/reaper.stop()/
// server.stop(), logged it, and then ran process.exit(0) REGARDLESS. A failed flush -- the case where
// pending queue/playback state was lost -- exited clean, so Docker, systemd and any supervisor read the
// stop as healthy. That falsifies an out-of-band signal: the one place a supervisor could learn the
// flush failed is the exit code, and it was hard-wired to success.
//
// THE FIX. Record whether the catch fired and exit non-zero when it did: process.exit(ok ? 0 : 1). The
// success path stays byte-for-byte a zero exit.
//
// WHY A SOURCE SCAN. server.ts is the process entrypoint -- it wires signal handlers and calls
// process.exit, so it cannot be imported into bun:test without terminating the runner, and this repo
// has no process harness. The exit-code contract is a property of the source text and is decidable by
// reading the function body.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// The Bun.serve entry, named from the repo root.
const SERVER = 'apps/core/server.ts';

// Blank block and line comments, preserving newlines, so a commented-out exit line cannot satisfy or
// trip a guard.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

// Isolate the gracefulShutdown body via a brace-depth walk, so the assertions cannot be satisfied by
// unrelated code elsewhere in the file.
function shutdownBody(src: string): string {
	const start = src.indexOf('function gracefulShutdown');
	expect(start, 'gracefulShutdown not found in server.ts').toBeGreaterThan(-1);
	const open = src.indexOf('{', start);
	let depth = 0;
	let i = open;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) break;
		}
	}
	return src.slice(open, i + 1);
}

test('gracefulShutdown does NOT exit(0) unconditionally -- a failed flush exits non-zero', () => {
	const body = shutdownBody(stripComments(read(SERVER)));
	// The catch must RECORD failure rather than only log it: an ok-style flag assigned inside the catch.
	expect(body).toMatch(/catch\s*\([^)]*\)\s*\{[\s\S]*?\bok\s*=\s*false/);
	// The exit must be CONDITIONAL on that flag -- non-zero when the catch fired.
	expect(body).toMatch(/process\.exit\(\s*ok\s*\?\s*0\s*:\s*[1-9]/);
	// And there must be NO unconditional exit(0) -- the exact shape of the defect.
	expect(body).not.toMatch(/process\.exit\(\s*0\s*\)/);
});
