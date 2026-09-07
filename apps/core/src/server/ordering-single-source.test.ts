// guard: the server derives the room's ordering from the ONE exported source, not a hand copy.
//
// THE DEFECT (#184). The `Ordering` a room runs on was assembled TWICE. `orderingOf(deps)` in
// realtime/hub.ts is the exported source, and its docstring says it exists "so there is exactly one
// place that decides what the server considers the current ordering — a second source is how the
// server would come to pick a different next than the queue every client is looking at." But
// app.ts built a SECOND copy by hand — an inline `{ order: settings.getRoom().queueOrder, lastSungAt:
// singHistoryFrom(singers.listPublic()) }` literal — and fed THAT to AuthoritativeState. So the store
// (the queue every client renders) reseqed on one derivation while the player (who actually sings
// next) ran orderingOf on the other. They were value-identical, so nothing failed; but editing either
// copy silently diverges the displayed order from the played order, and the suite is blind to it
// (both mutants the issue lists — order:'fcfs', lastSungAt:undefined — ship 0 fail).
//
// THE FIX. app.ts now calls orderingOf() instead of restating it, so there is one derivation. This
// guard pins that: the ordering fed to AuthoritativeState must come from orderingOf, and app.ts must
// NOT reconstruct it by hand. WHY A SOURCE SCAN: app.ts is the Bun.serve composition root — getApp()
// wires real repositories to a real sqlite db and has no pure seam to unit-test the construction of.
// Whether the ordering is derived through the single source is a decidable property of the source, so
// the guard reads app.ts. Re-introduce a hand copy and this is the assertion that reds. Do NOT relax
// this into "the two literals produce equal values" — that would pin the duplication the fix removed.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Blank out comments before scanning so a mention in a comment cannot satisfy (or trip) the check
// while the live code has diverged. Blanks rather than deletes so offsets still line up. Matches the
// repo's stripComments convention (session-cookie-attributes.test.ts et al.).
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server.
const APP = stripComments(readFileSync(join(import.meta.dir, 'app.ts'), 'utf8'));

// The AuthoritativeState construction and the getter it takes as its ordering argument. The getter is
// the third constructor argument — an arrow (`() => ...`) that produces the current Ordering. Capture
// from `new AuthoritativeState(` to the close of the statement so we scan only that expression, not
// the whole file.
function orderingGetter(): string {
	const m = APP.match(/new AuthoritativeState\([\s\S]*?\)\);/);
	expect(m, 'app.ts must construct AuthoritativeState').not.toBeNull();
	return m![0];
}

test('app.ts constructs AuthoritativeState (non-vacuous sentinel) (#184)', () => {
	// If this ever stops matching, the two behavioural assertions below are meaningless — so pin the
	// thing they scan is actually present. This is the composition root's one authoritative state.
	expect(APP).toMatch(/new AuthoritativeState\(/);
});

test('the room ordering is derived through the single orderingOf source, not restated (#184)', () => {
	// PRESENCE: the ordering getter fed to AuthoritativeState must call the exported orderingOf, and
	// orderingOf must be imported from the realtime hub (the one place that decides the ordering).
	const getter = orderingGetter();
	expect(getter).toMatch(/orderingOf\(/);
	expect(APP).toMatch(/import\s*\{[^}]*\borderingOf\b[^}]*\}\s*from\s*'\.\/realtime\/hub'/);
});

test('app.ts does NOT hand-assemble a second ordering copy (#184)', () => {
	// ABSENCE: the mutants the issue lists live inside a hand-written ordering literal — an object with
	// both `order:` and `lastSungAt:` keys fed to the state. Once app.ts routes through orderingOf,
	// that literal is gone. Re-introducing either shape (a full literal, or building lastSungAt from
	// singHistoryFrom in the composition root) is the divergence this guard forbids.
	const getter = orderingGetter();
	expect(getter).not.toMatch(/lastSungAt\s*:/);
	// singHistoryFrom belongs inside orderingOf (in hub.ts), not restated at the composition root.
	expect(APP).not.toMatch(/singHistoryFrom\(/);
});
