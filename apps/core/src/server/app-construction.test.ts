// §4 (#460): getApp() declared plays, reaper and workerHub as non-optional on EncoreApp but filled
// them with `null as never`, patching the real values in after the object literal. The circularity is
// real — workerHub closes over app.toWorker/publish, reaper needs workerHub.dispatch — but `null as
// never` LIED to the type system: any read of app.reaper between the literal and its patch got null
// with no type error, while EncoreApp's contract claimed a JobReaper. The fix builds the three as
// locals that capture `app` by reference (the closures only run long after construction) and places
// the real values in the literal, so `app` is never observed as null-typed.
//
// This is a SOURCE-SCAN guard because the defect is a type-level lie with NO runtime signature —
// reverting to `null as never` produces byte-identical runtime behavior, so only the source can pin
// it. Reverting the §4 fix (re-introducing `null as never` for any of the three, or reassigning them
// after the literal via `app.plays =` / `app.reaper =` / `app.workerHub =`) reds this.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(import.meta.dir, 'app.ts');
const src = readFileSync(APP, 'utf8');

// Only look at getApp()'s body, from its signature to setPublish (the next export). A `null as never`
// legitimately used elsewhere in the file would not concern §4.
const start = src.indexOf('export function getApp()');
const end = src.indexOf('export function setPublish', start);
const body = start > -1 && end > -1 ? src.slice(start, end) : '';

test('§4: getApp() body was located for scanning', () => {
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
});

test('§4: getApp() does not fill app fields with `null as never`', () => {
	// The lie the fix removed. A comment MENTIONS the phrase to explain the history; strip line
	// comments before scanning so the explanation does not red its own guard.
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
