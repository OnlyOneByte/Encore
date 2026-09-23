// guard: process-scars.ts must expose exactly ONE "is this scar alive" rule. It used to export a second
// liveness predicate, `scarActive`, with zero non-test callers — the one a reader would reach for, being the
// only one NAMED after the question — yet it omitted the `&& scar.media` term `pruneScars` requires, so a
// media-less scar was DEAD to the module and ALIVE to its public-looking predicate. Comments are blanked
// first; the parse check backstops a source scan's blindness to a SyntaxError.
import { readFileSync } from 'node:fs';
import { test, expect } from 'bun:test';
import { at } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const SRC_PATH = at('src/lib/stores/process-scars.ts');
const SRC_RAW = readFileSync(SRC_PATH, 'utf8');
const SRC = stripComments(SRC_RAW);

test('process-scars.ts parses — a source scan is blind to a SyntaxError', () => {
	expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(SRC_RAW)).not.toThrow();
});

test('the dead scarActive predicate is gone — no re-export, no re-declaration', () => {
	// The module had one export of it and no internal use, so a correct tree names it nowhere but comments.
	expect(SRC).not.toMatch(/\bscarActive\b/);
});

test('pruneScars is the single live liveness rule and keeps its media term', () => {
	// Isolate pruneScars's body so the assertion cannot be satisfied by unrelated code.
	const sig = SRC.indexOf('export function pruneScars');
	expect(sig).toBeGreaterThanOrEqual(0);
	const open = SRC.indexOf('{', sig);
	expect(open).toBeGreaterThanOrEqual(0);
	let depth = 0,
		end = -1;
	for (let i = open; i < SRC.length; i++) {
		if (SRC[i] === '{') depth++;
		else if (SRC[i] === '}') {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	expect(end).toBeGreaterThan(open);
	const body = SRC.slice(open, end + 1);
	// The live rule: an unexpired deadline AND a media snapshot — `&& scar.media` is the term scarActive omitted.
	expect(body).toMatch(/scar\.expiresAt\s*>\s*now\s*&&\s*scar\.media/);
});

test('the expiry comparison lives ONLY inside pruneScars — no restated liveness rule under any name', () => {
	// The name arm above stops `scarActive` returning verbatim, but the finding was that the EXPRESSION was
	// wrong, so re-adding the same comparison under a new name must red too: an `expiresAt` </> comparison IS
	// the liveness decision and may exist in exactly one place. Any second predicate must DERIVE from
	// pruneScars, never re-compare. The module's other two `expiresAt` uses are a type field and a `+` write.
	const sig = SRC.indexOf('export function pruneScars');
	expect(sig).toBeGreaterThanOrEqual(0);
	const open = SRC.indexOf('{', sig);
	expect(open).toBeGreaterThanOrEqual(0);
	let depth = 0,
		end = -1;
	for (let i = open; i < SRC.length; i++) {
		if (SRC[i] === '{') depth++;
		else if (SRC[i] === '}') {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	expect(end).toBeGreaterThan(open);
	// The module with pruneScars carved out: everything left must be free of an expiry comparison.
	const outsidePrune = SRC.slice(0, open) + SRC.slice(end + 1);
	expect(outsidePrune).not.toMatch(/expiresAt\s*[<>]/);
	// Non-vacuity: the comparison genuinely EXISTS in the carved-out body, so green means "where it belongs".
	const pruneBody = SRC.slice(open, end + 1);
	expect(pruneBody).toMatch(/expiresAt\s*[<>]/);
});

test('the three live entry points survive — deleting the module reds instead of vacuously passing', () => {
	// Non-vacuity sentinel: the reachable API. activeScars is the only one the app calls; the other two route through pruneScars.
	expect(SRC).toMatch(/export function activeScars\b/);
	expect(SRC).toMatch(/export function recordScar\b/);
	expect(SRC).toMatch(/export function clearScar\b/);
});
