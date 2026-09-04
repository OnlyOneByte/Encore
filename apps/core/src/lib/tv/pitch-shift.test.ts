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
	analysisHop,
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

test('analysisHop: synth hop scaled by ratio (the time-stretch that cancels the resample)', () => {
	// Pitch up (ratio > 1) reads MORE input per output grain -> more grains overlap onto the same span
	// -> time is stretched back to normal after the pitch rose.
	expect(analysisHop(256, 1)).toBe(256);
	expect(analysisHop(256, 2)).toBe(512);
	expect(analysisHop(256, 0.5)).toBe(128);
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
