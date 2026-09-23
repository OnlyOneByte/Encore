// guard: a graceful shutdown whose state flush FAILED must exit NON-ZERO. server.ts's gracefulShutdown()
// caught an error from flushNow()/reaper.stop()/server.stop(), logged it, then ran process.exit(0)
// REGARDLESS — so a stop that lost pending queue/playback state read as healthy to Docker, systemd and any
// supervisor, falsifying the one out-of-band signal that could have reported it. A SOURCE SCAN because
// server.ts wires signal handlers and calls process.exit, so importing it into bun:test kills the runner.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// The Bun.serve entry, named from the repo root.
const SERVER = 'server.ts';

// Blank block and line comments, preserving newlines, so a commented-out exit line cannot satisfy a guard.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

// Isolate the gracefulShutdown body via a brace-depth walk, so nothing elsewhere in the file can satisfy
// these assertions.
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
