// guard: getApp() declared plays, reaper and workerHub non-optional on EncoreApp but filled them with
// `null as never`, patching the real values in after the object literal. The circularity is real (workerHub
// closes over app.toWorker/publish, reaper needs workerHub.dispatch) but `null as never` LIED to the type
// system: any read of app.reaper between the literal and its patch got null with no type error. The fix
// builds the three as locals that capture `app` by reference. A SOURCE SCAN because the defect is a
// type-level lie with NO runtime signature — reverting it is byte-identical at runtime.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// `read` throws when the file is missing, which matters because the two `not.toMatch` arms below would PASS
// on an empty body: `start`/`end` would be -1 and the absence assertions satisfied by nothing at all.
const src = read('src/lib/server/app.ts');

// Only getApp()'s body, up to the next export: a `null as never` elsewhere in the file is not this defect.
const start = src.indexOf('export function getApp()');
const end = src.indexOf('export function setPublish', start);
const body = start > -1 && end > -1 ? src.slice(start, end) : '';

test('§4: getApp() body was located for scanning', () => {
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
});

test('§4: getApp() does not fill app fields with `null as never`', () => {
	// A comment MENTIONS the phrase to explain the history, so strip line comments before scanning.
	const codeOnly = body.replace(/\/\/[^\n]*/g, '');
	expect(codeOnly).not.toMatch(/null\s+as\s+never/);
});

test('§4: plays/workerHub/reaper are built as locals, not patched onto app after the literal', () => {
	const codeOnly = body.replace(/\/\/[^\n]*/g, '');
	// Built as `const <name> = new ...` before the literal.
	expect(codeOnly).toMatch(/const\s+plays\s*=\s*new\s+PlayTracker/);
	expect(codeOnly).toMatch(/const\s+workerHub\s*=\s*new\s+WorkerHub/);
	expect(codeOnly).toMatch(/const\s+reaper\s*=\s*new\s+JobReaper/);
	// And NOT reassigned onto app afterwards (the old patch-after-literal shape).
	expect(codeOnly).not.toMatch(/app\.plays\s*=/);
	expect(codeOnly).not.toMatch(/app\.workerHub\s*=/);
	expect(codeOnly).not.toMatch(/app\.reaper\s*=\s*new/);
});
