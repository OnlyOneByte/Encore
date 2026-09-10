// §2 (#460): four pitch helpers were production-dead — SEMITONES_PER_OCTAVE, hannWindow, synthesisHop
// and sampleAt had zero non-test references anywhere in apps/ or packages/. The worklet does NOT import
// them: it runs in a separate AudioWorkletGlobalScope and carries its OWN hann window, its own
// SYNTH_HOP = GRAIN / OVERLAP, and its own inline lerp. sampleAt was the sharp one — its old test
// pinned a "clamp, never read past the end" boundary for a function no audio flowed through, while the
// shipped read path (histSample) returns 0 out of range ON PURPOSE, the opposite semantics.
//
// So they were deleted, NOT bound to the worklet like the oracle three (grainLookahead / readLag /
// ALIGN_SEARCH, which pitch-worklet.test.ts uses as an independent check against the running worklet).
//
// This is a SOURCE-SCAN guard because the defect is "these exports exist at all". Reverting the §2
// deletion — re-adding any of the four as an export — reds this immediately. It also asserts the
// worklet string still carries its own windowing/hop/lerp, so a reviewer cannot argue the helpers were
// merely relocated: if the worklet grew an import of them instead, the "self-contained" arm reds.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PITCH = join(import.meta.dir, 'pitch-shift.ts');
const src = readFileSync(PITCH, 'utf8');

// The worklet source string spans from PITCH_WORKLET_SOURCE to its closing backtick; the module code
// is everything before it. Split so "is X exported from the module" is not fooled by a substring that
// only appears inside the worklet template literal.
const workletIdx = src.indexOf('PITCH_WORKLET_SOURCE');
const moduleCode = workletIdx > -1 ? src.slice(0, workletIdx) : src;
const workletSrc = workletIdx > -1 ? src.slice(workletIdx) : '';

test('§2: the four dead helpers are not exported from pitch-shift.ts', () => {
	expect(workletIdx).toBeGreaterThan(-1); // the split point exists
	for (const name of ['SEMITONES_PER_OCTAVE', 'hannWindow', 'synthesisHop', 'sampleAt']) {
		expect(moduleCode).not.toMatch(new RegExp(`export\\s+(?:const|function)\\s+${name}\\b`));
	}
});

test('§2: the oracle three are STILL exported (they are not dead — the double-entry check reads them)', () => {
	// Sentinel: proves the guard above is discriminating, not vacuously green because the module is
	// empty or the scan missed. These three must survive.
	for (const name of ['grainLookahead', 'readLag', 'ALIGN_SEARCH']) {
		expect(moduleCode).toMatch(new RegExp(`export\\s+(?:const|function)\\s+${name}\\b`));
	}
});

test('§2: the worklet carries its own hann window, SYNTH_HOP and inline lerp (not the deleted helpers)', () => {
	// Deletion is only correct because the worklet never depended on the four. Pin that: the worklet
	// string computes its own hop and window inline, so it cannot have been relying on the exports.
	expect(workletSrc).toMatch(/SYNTH_HOP\s*=\s*GRAIN\s*\/\s*OVERLAP/);
	expect(workletSrc).toMatch(/Math\.cos/); // its own Hann window, computed inline
	// and it must not import the deleted names back in (a relocation, not a deletion, would red here)
	for (const name of ['hannWindow', 'synthesisHop', 'sampleAt']) {
		expect(workletSrc).not.toContain(name);
	}
});
