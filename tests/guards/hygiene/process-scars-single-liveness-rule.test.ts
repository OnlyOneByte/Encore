// guard: process-scars.ts must expose exactly ONE "is this scar alive" rule.
//
// The module used to export a second liveness predicate, `scarActive`, with zero non-test callers. It
// was the one a reader would reach for (the only one NAMED after the question) yet it answered
// differently from the rule every entry point actually consults: it omitted the `&& scar.media` term
// that `pruneScars` requires, so a media-less scar was DEAD to the module and ALIVE to its
// public-looking predicate. It has been removed, leaving `pruneScars` as the single reachable rule that
// `recordScar` / `clearScar` / `activeScars` all route through.
//
// This scan pins that outcome where there is no pure function to exercise a deletion: it asserts the
// dead symbol does not reappear, the single live rule keeps its media term, and the three live entry
// points survive — so re-adding `scarActive`, weakening the live rule, or deleting the whole module all
// red. Comments are blanked first: the module's prose names `pruneScars` and `activeScars` in
// docstrings and never names `scarActive`, so a comment can neither satisfy nor trip any match, and
// the parse check backstops a source scan's blindness to a SyntaxError.
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
	// Any occurrence of the identifier in live code is a regression: the module had exactly one
	// export of it and no internal use, so a correct tree mentions it nowhere outside comments.
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
	// The live rule: unexpired deadline AND a media snapshot present. The `&& scar.media` term is the
	// exact clause scarActive omitted; dropping it here would re-introduce the divergence the removal closed.
	expect(body).toMatch(/scar\.expiresAt\s*>\s*now\s*&&\s*scar\.media/);
});

test('the expiry comparison lives ONLY inside pruneScars — no restated liveness rule under any name', () => {
	// The literal-name arm above stops `scarActive` coming back verbatim, but the finding behind the removal is that
	// the *expression* was wrong, not merely that the name was unused. Re-adding the same discredited
	// comparison under a new name (e.g. `isScarLive`) would slip past a name scan and is exactly the
	// edit §4 predicts the next dev writes. This arm enforces the "derive rather than restate" ruling:
	// a `expiresAt` </> comparison is the liveness decision, and it may exist in exactly one place —
	// pruneScars. Any second predicate must DERIVE from pruneScars (call it), never re-compare.
	//
	// `expiresAt` appears three times in the module: the `expiresAt: number` type field (:42), the
	// `expiresAt: now + PROCESS_SCAR_TTL_MS` write (:131), and the `scar.expiresAt > now` comparison (:75).
	// Only the third is a </> comparison, and it lives in pruneScars — so slicing pruneScars out and
	// scanning the remainder for a comparison is green today and reds on any restatement elsewhere.
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
	// The module with pruneScars's body carved out. Everything left must be free of an expiry
	// comparison — the write (:131) uses `+`, the type field (:42) uses `:`, neither matches `[<>]`.
	const outsidePrune = SRC.slice(0, open) + SRC.slice(end + 1);
	expect(outsidePrune).not.toMatch(/expiresAt\s*[<>]/);
	// Non-vacuity: the comparison genuinely EXISTS inside the carved-out body, so a green result means
	// "the one comparison is where it belongs", never "there is no comparison to find".
	const pruneBody = SRC.slice(open, end + 1);
	expect(pruneBody).toMatch(/expiresAt\s*[<>]/);
});

test('the three live entry points survive — deleting the module reds instead of vacuously passing', () => {
	// Non-vacuity sentinel: the reachable API this module exists for. activeScars is the only one the
	// app calls; recordScar and clearScar are the other two entry points that route through pruneScars.
	expect(SRC).toMatch(/export function activeScars\b/);
	expect(SRC).toMatch(/export function recordScar\b/);
	expect(SRC).toMatch(/export function clearScar\b/);
});
