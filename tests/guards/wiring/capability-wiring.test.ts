// guard: `capabilities.ts` is the ONE place that answers "is this actor allowed to do that?". Caught:
// `queue:remove-any` and `queue:reorder-any` had NO asker — remove/move were gated by membership alone and
// never consulted `can()` — so narrowing `can()` would silently leave exactly those two ops open to every
// joined singer. The defect is a MISSING CALL SITE, which is decidable from source.
// See docs/GUARDS.md#wiring
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const hubSrc = read('src/lib/server/realtime/hub.ts');

/** The remove arm's own comment contains `queue:remove-any`, so prose must not satisfy an assertion. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// Isolate validateCommand's body so a can() call elsewhere in the file cannot satisfy the guard on the
// remove/move ops' behalf.
function validateCommandBody(src: string): string {
	const start = src.indexOf('export function validateCommand');
	expect(start).toBeGreaterThan(-1);
	const rest = src.slice(start + 1);
	const nextExport = rest.indexOf('\nexport function');
	return nextExport === -1 ? src.slice(start) : src.slice(start, start + 1 + nextExport);
}

// Slice ONE switch arm, so a capability gate can only satisfy the arm it lives in: a whole-body match
// stays green when the two capability strings are swapped between arms, or when an arm's gate is moved
// out and left elsewhere in the body. Comments are stripped first so a commented-out `case` cannot move
// an arm boundary.
function switchArm(body: string, op: string): string {
	const src = stripComments(body);
	const label = `case '${op}':`;
	const start = src.indexOf(label);
	expect(start).toBeGreaterThan(-1); // non-vacuous: the arm must exist
	const after = src.slice(start + label.length);
	// A terminator MUST follow the arm: falling back to end-of-body when none does would degrade the
	// last arm's assertion into the whole-body scan this guard replaces, satisfiable by a decoy gate
	// after the switch. Every op's arm here is followed by a label, so a missing one is a real regression.
	const nextCase = after.search(/\n\s*(case '|default:)/);
	expect(nextCase).toBeGreaterThan(-1);
	return after.slice(0, nextCase);
}

/**
 * The full `if (!can(…)) return '<reason>'` gate shape, so an inert `can(…)` whose result is discarded
 * cannot satisfy it. The tail must be a returned STRING: `return null` is validateCommand's "command is
 * valid" answer, so a gate whose consequent is `return null` APPROVES on denial.
 */
function gateFor(cap: string): RegExp {
	return new RegExp(
		`if\\s*\\(\\s*!can\\(\\s*\\{\\s*singerId:\\s*deps\\.actorSingerId\\s*\\}\\s*,\\s*'${cap.replace(/[-]/g, '\\$&')}'\\s*\\)\\s*\\)\\s*return\\s*'`
	);
}

test("validateCommand's 'remove' arm gates through can('queue:remove-any') — arm-scoped", () => {
	expect(switchArm(validateCommandBody(hubSrc), 'remove')).toMatch(gateFor('queue:remove-any'));
});

test("validateCommand's 'move' arm gates through can('queue:reorder-any') — arm-scoped", () => {
	expect(switchArm(validateCommandBody(hubSrc), 'move')).toMatch(gateFor('queue:reorder-any'));
});

test('hub imports can from the capabilities module (the ONE decision point)', () => {
	expect(hubSrc).toMatch(/import\s*\{\s*can\s*\}\s*from\s*'\.\.\/capabilities'/);
});
