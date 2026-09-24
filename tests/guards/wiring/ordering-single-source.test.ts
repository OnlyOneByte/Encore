// guard: `orderingOf(deps)` in realtime/hub.ts is the ONE place that decides what the server considers the
// current ordering; a second source is how the server picks a different next song than the queue every
// client sees. app.ts hand-built a second `{ order, lastSungAt }` literal and fed THAT to AuthoritativeState;
// they were value-identical, so nothing failed. Do NOT relax this into "the two literals produce equal
// values", which pins the duplication instead of banning it. See docs/GUARDS.md#wiring-single-source
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// `read` throws when the file is missing, which keeps the two absence arms below from being satisfied by
// an empty string.
const APP = stripComments(read('src/lib/server/app.ts'));

/** Only the `new AuthoritativeState(…)` statement, so the arms scan that expression and not the file. */
function orderingGetter(): string {
	const m = APP.match(/new AuthoritativeState\([\s\S]*?\)\);/);
	expect(m, 'app.ts must construct AuthoritativeState').not.toBeNull();
	return m![0];
}

test('app.ts constructs AuthoritativeState (non-vacuous sentinel)', () => {
	// If this stops matching, the two arms below scan nothing and are meaningless.
	expect(APP).toMatch(/new AuthoritativeState\(/);
});

test('the room ordering is derived through the single orderingOf source, not restated', () => {
	const getter = orderingGetter();
	expect(getter).toMatch(/orderingOf\(/);
	expect(APP).toMatch(/import\s*\{[^}]*\borderingOf\b[^}]*\}\s*from\s*'\.\/realtime\/hub'/);
});

test('app.ts does NOT hand-assemble a second ordering copy', () => {
	// A hand-written `lastSungAt:` key in the getter, or `singHistoryFrom` anywhere at the composition
	// root, is the second derivation returning — both belong inside `orderingOf` in hub.ts.
	const getter = orderingGetter();
	expect(getter).not.toMatch(/lastSungAt\s*:/);
	expect(APP).not.toMatch(/singHistoryFrom\(/);
});
