// The four-step terminal-fail epilogue (settle the gate, broadcast media:status, log one line, reclaim
// scratch) lives in ONE exported `reportTerminalFailure`, and app.ts's `getApp()` WIRES the reaper's
// onFailed hook to it. `getApp()` has no unit harness and reaper.test.ts supplies its own onFailed, so
// reverting the wiring leaves every reaper test green while a reaper-killed process is silent. The
// function's text is pinned too, because a step behind a dead branch or after an early return still
// passes a broadcast-only behavioural assertion.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const APP = stripComments(readFileSync(at('src/lib/server/app.ts'), 'utf8'));
const MK = stripComments(readFileSync(at('src/lib/server/jobs/process.ts'), 'utf8'));

test('app.ts imports reportTerminalFailure — the one shared terminal-fail epilogue', () => {
	expect(APP).toMatch(/import\s*\{[^}]*\breportTerminalFailure\b[^}]*\}\s*from\s*'\.\/jobs\/process'/);
});

test('app.ts wires the JobReaper onFailed hook through reportTerminalFailure over mediaById + publish', () => {
	// An unwired onFailed means a reaper-killed process never settles its gate, so readyToSing never flips
	// and rotation holds the queue entry forever — silently.
	const start = APP.indexOf('onFailed:');
	expect(start).toBeGreaterThanOrEqual(0);
	// A generous window that still cannot pick up unrelated code, because `reportTerminalFailure(job,
	// 'reaper', …)` is unique to this seam.
	const hook = APP.slice(start, start + 400);
	expect(hook).toMatch(/reportTerminalFailure\(\s*job,\s*'reaper'/);
	// Both deps: the app's catalog, and a broadcast sink routed through the room publisher.
	expect(hook).toMatch(/broadcast:\s*\(e\)\s*=>\s*app\.publish\(e\)/);
	expect(hook).toMatch(/mediaById/);
	// Whole-file backstop, so dropping the hook entirely also reds.
	expect(APP).toMatch(/onFailed:\s*\(job\)\s*=>\s*reportTerminalFailure\(job,\s*'reaper'/);
});

test('reportTerminalFailure performs all four terminal-fail epilogue steps', () => {
	// Body-scoped, so a match cannot be satisfied by unrelated process.ts code.
	const sig = MK.indexOf('export function reportTerminalFailure');
	expect(sig).toBeGreaterThanOrEqual(0);
	const open = MK.indexOf('{', sig);
	expect(open).toBeGreaterThanOrEqual(0);
	let depth = 0,
		end = -1;
	for (let i = open; i < MK.length; i++) {
		if (MK[i] === '{') depth++;
		else if (MK[i] === '}') {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	expect(end).toBeGreaterThan(open);
	const fn = MK.slice(open, end + 1);
	// (1) Settle the gate FIRST, anchored at the top of the body so it cannot be dropped or dead-wrapped
	//     while the room-facing half still broadcasts.
	const fnBody = fn.slice(fn.indexOf('{') + 1);
	expect(fnBody).toMatch(/^\s*const\s+settled\s*=\s*settleGatesForFailedJob\(job,\s*deps\.mediaById\);/);
	// (2) Broadcast media:status, ordered AFTER the settle so the frame carries the settled state.
	expect(fn).toMatch(/shouldBroadcastProcess\(job,\s*media\)/);
	expect(fn).toMatch(/type:\s*'media:status'/);
	expect(fn).toMatch(/status:\s*mediaStatusFor\(job\)/);
	const settleIdx = fn.indexOf('settleGatesForFailedJob');
	const branchIdx = fn.indexOf('shouldBroadcastProcess');
	expect(settleIdx).toBeGreaterThanOrEqual(0);
	expect(branchIdx).toBeGreaterThan(settleIdx);
	// (3) One operator log line, in the uniform key=value format so one grep finds every path.
	expect(fn).toMatch(/console\.warn\(/);
	expect(fn).toMatch(/cause=\$\{cause\}/);
	expect(fn).toMatch(/job=\$\{job\.id\}/);
	expect(fn).toMatch(/media=\$\{job\.mediaId\}/);
	expect(fn).toMatch(/attempts=\$\{job\.attempts\}/);
	expect(fn).toMatch(/reason=/);
	// (4) Reclaim the job's scratch — the step the TTL branch used to omit.
	expect(fn).toMatch(/cleanJobWork\(job\.id\)/);
});
