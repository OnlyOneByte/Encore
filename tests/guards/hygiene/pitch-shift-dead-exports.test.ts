// guard: four pitch helpers (SEMITONES_PER_OCTAVE, hannWindow, synthesisHop, sampleAt) were production-dead — zero
// non-test references. The worklet does NOT import them: it runs in a separate AudioWorkletGlobalScope carrying its
// OWN hann window, SYNTH_HOP = GRAIN / OVERLAP and inline lerp. sampleAt was the sharp one: its test pinned a
// "clamp, never read past the end" boundary for a function no audio flowed through, while the shipped read path
// (histSample) returns 0 out of range ON PURPOSE. A source scan because the defect is "these exports exist at
// all"; the self-contained arm stops a relocation passing itself off as a deletion.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const src = read('src/lib/tv/pitch-shift.ts');

// Split at PITCH_WORKLET_SOURCE so "is X exported" is not fooled by a substring inside the worklet template.
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
	// Sentinel: proves the arm above is discriminating, not vacuously green because the scan missed.
	for (const name of ['grainLookahead', 'readLag', 'ALIGN_SEARCH']) {
		expect(moduleCode).toMatch(new RegExp(`export\\s+(?:const|function)\\s+${name}\\b`));
	}
});

test('§2: the worklet carries its own hann window, SYNTH_HOP and inline lerp (not the deleted helpers)', () => {
	// Deletion is only correct because the worklet never depended on the four: pin that it computes its own, and that
	// it does not import the deleted names back in — a relocation rather than a deletion would red here.
	expect(workletSrc).toMatch(/SYNTH_HOP\s*=\s*GRAIN\s*\/\s*OVERLAP/);
	expect(workletSrc).toMatch(/Math\.cos/); // its own Hann window, computed inline
	for (const name of ['hannWindow', 'synthesisHop', 'sampleAt']) {
		expect(workletSrc).not.toContain(name);
	}
});
