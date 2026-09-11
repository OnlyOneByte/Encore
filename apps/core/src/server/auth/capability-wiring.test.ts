// capabilities.ts:1 calls itself "the ONE place that answers 'is this actor allowed to do that?'" and
// :9-11 promises that gating any capability later is "an edit HERE and nowhere else". For two of the
// five capabilities that promise was false: `queue:remove-any` and `queue:reorder-any` had NO asker —
// the queue's remove/move ops were gated by membership only (hub.ts's actorSingerId check) and never
// consulted can(). So narrowing can() to add a host gate would silently leave remove/reorder open to
// every joined singer, exactly the operations those two capabilities were named for.
//
// There is nothing to assert BEHAVIOURALLY today: can() returns Boolean(actor?.singerId), so with the
// wiring in place remove/move still succeed for any joined singer (Angelo's "every joined singer is a
// host" ruling). The regression is a MISSING CALL SITE, so the guard is a source-level assertion that
// hub.ts's validateCommand GATES each op through can() with the capability it is named for — the
// `if (!can(...)) return` guard shape, not merely a call whose result is discarded (an inert call would
// re-open the bug the moment can() is narrowed).
//
// the earlier version matched each capability string against the WHOLE validateCommand body, so
// three defect-preserving edits to hub.ts all stayed GREEN — a false safety that materialises the day
// can() is narrowed per capabilities.ts:9-11:
//   M1  swap the two strings between arms (remove arm gates 'queue:reorder-any', move arm gates
//       'queue:remove-any') — both strings still appear SOMEWHERE in the body, so a whole-body match
//       passes while remove is gated by the reorder capability and vice versa;
//   M2  move the remove arm's can() gate out into another arm (so remove is membership-only again) —
//       the string still appears in the body, so a whole-body match passes;
//   M3  replace the remove arm's gate with a bare `return null` while leaving a `queue:remove-any`
//       gate somewhere else — same whole-body false positive.
// The fix binds each capability string to ITS OWN switch arm: slice the arm the op belongs to and
// assert THAT slice carries the `if (!can(...)) return` gate for the capability it is named for. Each
// of M1/M2/M3 then reds the matching arm assertion, because the gate is no longer in the arm's slice.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const hubSrc = readFileSync(fileURLToPath(new URL('../realtime/hub.ts', import.meta.url)), 'utf-8');

// Strip // line comments and /* */ block comments so prose mentioning a capability string (the remove
// arm's own comment literally contains `queue:remove-any`) can neither satisfy nor trip an assertion.
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

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

// Slice a single switch arm — from `case '<op>':` up to the next `case '` / `default:` label — so a
// capability gate can only satisfy the arm it actually lives in. Comments are stripped FIRST so a
// commented-out `case` or a capability string in prose cannot move or satisfy an arm boundary.
function switchArm(body: string, op: string): string {
	const src = stripComments(body);
	const label = `case '${op}':`;
	const start = src.indexOf(label);
	expect(start).toBeGreaterThan(-1); // non-vacuous: the arm must exist
	const after = src.slice(start + label.length);
	// a terminator MUST follow the arm. The old fallback (`nextCase === -1 ? after`) sliced to the
	// END of validateCommand's body when no `case '`/`default:` label followed — so making an op the last
	// arm degraded the assertion back to the whole-body scan this guard replaces (a decoy gate after the
	// switch would satisfy it). Fail loudly instead: every op's arm here is followed by another `case '`
	// or `default:`, so a missing terminator is a real regression, not a case to slice past.
	const nextCase = after.search(/\n\s*(case '|default:)/);
	expect(nextCase).toBeGreaterThan(-1); // arm must be bounded by a following label, never end-of-body
	return after.slice(0, nextCase);
}

// The `if (!can({ singerId: deps.actorSingerId }, '<cap>')) return` gate shape, arm-scoped. Asserting
// the full guard shape (not a bare `can(...)` call) means an inert call whose result is discarded — the
// classic way to re-open #106 the moment can() is narrowed — does not satisfy it.
function gateFor(cap: string): RegExp {
	// The tail is `return\s*'` (a returned STRING), NOT a bare `return`. #220: `return null` is
	// validateCommand's "command is valid" answer — handleQueueCommand does `if (err) { ...reject... }`,
	// so a returned string REJECTS and null PROCEEDS. A gate whose consequent is `return null` therefore
	// APPROVES on denial: permanently open while keeping the exact `if (!can(...))` shape. Requiring a
	// string consequent reds that mutation, which is the hole #106/#220 exist to protect.
	return new RegExp(
		`if\\s*\\(\\s*!can\\(\\s*\\{\\s*singerId:\\s*deps\\.actorSingerId\\s*\\}\\s*,\\s*'${cap.replace(/[-]/g, '\\$&')}'\\s*\\)\\s*\\)\\s*return\\s*'`
	);
}

test("validateCommand's 'remove' arm gates through can('queue:remove-any') — arm-scoped", () => {
	// scoped to the remove arm, so swapping strings (M1), moving the gate to another arm (M2),
	// or replacing it with `return null` (M3) all red — the gate must live in THIS arm.
	expect(switchArm(validateCommandBody(hubSrc), 'remove')).toMatch(gateFor('queue:remove-any'));
});

test("validateCommand's 'move' arm gates through can('queue:reorder-any') — arm-scoped", () => {
	expect(switchArm(validateCommandBody(hubSrc), 'move')).toMatch(gateFor('queue:reorder-any'));
});

test('hub imports can from the capabilities module (the ONE decision point)', () => {
	expect(hubSrc).toMatch(/import\s*\{\s*can\s*\}\s*from\s*'\.\.\/auth\/capabilities'/);
});
