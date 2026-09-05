// Pure-maths guard for the browser pitch shifter. The AUDIBLE behaviour cannot be tested here — there
// is no audio hardware and no AudioContext in bun:test — so this covers only the ratio arithmetic and
// the OLA framing/window maths, which are the parts a regression would silently get wrong.
import { test, expect } from 'bun:test';
import {
	SEMITONES_PER_OCTAVE,
	semitonesToRatio,
	needsShift,
	hannWindow,
	synthesisHop,
	grainLookahead,
	readLag,
	ALIGN_SEARCH,
	sampleAt
} from './pitch-shift';

test('semitonesToRatio: 0 is EXACTLY 1 (bit-exact bypass check)', () => {
	// The caller keys "bypass" off ratio === 1, so this must not be 0.9999999.
	expect(semitonesToRatio(0)).toBe(1);
	expect(Object.is(semitonesToRatio(0), 1)).toBe(true);
});

test('semitonesToRatio: an octave up/down is 2×/0.5×', () => {
	expect(semitonesToRatio(SEMITONES_PER_OCTAVE)).toBeCloseTo(2, 10);
	expect(semitonesToRatio(-SEMITONES_PER_OCTAVE)).toBeCloseTo(0.5, 10);
});

test('semitonesToRatio: a fifth up is ~1.4983 (equal temperament)', () => {
	// 7 semitones — the ±MAX_KEY_SHIFT bound.
	expect(semitonesToRatio(7)).toBeCloseTo(1.4983, 3);
	expect(semitonesToRatio(-7)).toBeCloseTo(0.6674, 3);
});

test('semitonesToRatio: non-finite falls back to 1 (never a wild transpose)', () => {
	expect(semitonesToRatio(NaN)).toBe(1);
	expect(semitonesToRatio(Infinity)).toBe(1);
	expect(semitonesToRatio(-Infinity)).toBe(1);
});

test('needsShift: only a non-unity ratio needs the graph', () => {
	expect(needsShift(0)).toBe(false);
	expect(needsShift(NaN)).toBe(false);
	expect(needsShift(1)).toBe(true);
	expect(needsShift(-1)).toBe(true);
	expect(needsShift(7)).toBe(true);
});

test('hannWindow: periodic form starts at 0 and is symmetric', () => {
	const w = hannWindow(8);
	expect(w.length).toBe(8);
	expect(w[0]).toBeCloseTo(0, 10); // periodic Hann: w[0] === 0
	// symmetric about the centre (periodic window is symmetric around n/2)
	expect(w[1]).toBeCloseTo(w[7], 10);
	expect(w[2]).toBeCloseTo(w[6], 10);
	expect(w[4]).toBeCloseTo(1, 10); // peak at the middle
});

test('hannWindow: 75%-overlap squared windows sum to a near-constant (no ripple)', () => {
	// The reason for a PERIODIC Hann at 4× overlap: shifted copies of w^2 sum flat, so OLA introduces
	// no amplitude modulation across grain boundaries.
	const N = 1024;
	const hop = synthesisHop(N, 4); // 256
	const w = hannWindow(N);
	// Sum w^2 at a set of offsets a full hop apart, sampled mid-window to avoid edge partial-coverage.
	const at = (center: number) => {
		let s = 0;
		for (let k = -2; k <= 2; k++) {
			const idx = center - k * hop;
			if (idx >= 0 && idx < N) s += w[idx] * w[idx];
		}
		return s;
	};
	const a = at(400);
	const b = at(500);
	const c = at(600);
	expect(a).toBeCloseTo(b, 2);
	expect(b).toBeCloseTo(c, 2);
});

test('synthesisHop: grain/overlap, floored, never below 1', () => {
	expect(synthesisHop(1024, 4)).toBe(256);
	expect(synthesisHop(1000, 3)).toBe(333);
	expect(synthesisHop(2, 8)).toBe(1); // clamps up from 0
});

test('grainLookahead / readLag: the read pointer must lag the write head, and by how much', () => {
	// REPLACES a test that asserted `analysisHop(256, 2) === 512`. That formula WAS the shipped bug:
	// it is the analysis hop for a design where resampling is a separate stage after time-stretching,
	// but here the resample is fused into the grain read, so scaling the hop by ratio applied the tempo
	// correction twice and the read pointer ran away from the write pointer without bound.
	// A slow read needs LESS lookahead, not more: at ratio 0.5 a 1024-sample grain spans 512 input.
	expect(grainLookahead(1024, 1)).toBe(1024);
	expect(grainLookahead(1024, 2)).toBe(2048);
	expect(grainLookahead(1024, 0.5)).toBe(512);
	// The lag adds the alignment search and one hop, so neither a block edge nor the SOLA search can
	// read past the newest input.
	expect(readLag(1024, 256, 1)).toBe(1024 + ALIGN_SEARCH + 256);
	expect(readLag(1024, 256, 1.5)).toBe(1536 + ALIGN_SEARCH + 256);
});

test('sampleAt: the LAST cell interpolates against nothing rather than reading past the end', () => {
	// Mutation-proven gap: loosening the `i >= buf.length - 1` guard to `i >= buf.length` survived the
	// whole suite, because the tests probed only far-out indices (-5, 99) and never the boundary. Past
	// the last cell there is no neighbour to interpolate with, and reading one would be NaN.
	const buf = new Float32Array([0, 1, 2, 3]);
	expect(sampleAt(buf, 2.5)).toBeCloseTo(2.5, 6); // interpolates normally below the boundary
	expect(sampleAt(buf, 3)).toBe(3); // exactly the last cell
	expect(sampleAt(buf, 3.5)).toBe(3); // inside the last cell: clamp, never read buf[4]
	expect(Number.isNaN(sampleAt(buf, 3.5))).toBe(false);
	expect(Number.isNaN(sampleAt(buf, 3.999))).toBe(false);
});

test('sampleAt: linear interpolation between neighbours, clamped at the edges', () => {
	const buf = new Float32Array([0, 10, 20, 30]);
	expect(sampleAt(buf, 0)).toBe(0);
	expect(sampleAt(buf, 1)).toBe(10);
	expect(sampleAt(buf, 1.5)).toBeCloseTo(15, 10);
	expect(sampleAt(buf, 2.25)).toBeCloseTo(22.5, 10);
	// out of range clamps rather than reading garbage
	expect(sampleAt(buf, -5)).toBe(0);
	expect(sampleAt(buf, 99)).toBe(30);
	expect(sampleAt(new Float32Array(0), 3)).toBe(0);
});
