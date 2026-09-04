import { describe, expect, it } from 'bun:test';
import {
	GUIDE_DEADBAND_SEC,
	GUIDE_MAX_RATE_TRIM,
	GUIDE_RESEEK_SEC,
	guideCorrection
} from './guide-sync';

/*
 * These tests exist for one reported defect: the guiding track crackled. The cause was that drift was
 * corrected by seeking (`vocals.currentTime = ...`) on the master's ~4Hz timeupdate with a 40ms
 * tolerance — so an unlockable pair of media elements produced a decoder flush every few hundred ms.
 *
 * The invariant worth defending is therefore not "drift is small" but "ordinary drift does not
 * produce a seek". That is what the first block pins.
 */

describe('guideCorrection — ordinary drift never seeks', () => {
	it('holds inside the deadband', () => {
		expect(guideCorrection(10, 10).kind).toBe('hold');
		expect(guideCorrection(10 + GUIDE_DEADBAND_SEC / 2, 10).kind).toBe('hold');
		expect(guideCorrection(10 - GUIDE_DEADBAND_SEC / 2, 10).kind).toBe('hold');
	});

	it('trims rather than seeks across the whole band that used to seek', () => {
		// 40ms was the OLD seek threshold. Every one of these once flushed the decoder.
		// Kept just inside the reseek boundary: `10 + 0.3 - 10` is 0.30000000000000071 in binary
		// floating point, which is genuinely over the threshold, so testing the exact edge would be
		// asserting against float representation rather than against the policy.
		for (const drift of [0.02, 0.04, 0.08, 0.15, 0.25, GUIDE_RESEEK_SEC - 0.005]) {
			expect(guideCorrection(10 + drift, 10).kind).toBe('trim');
			expect(guideCorrection(10 - drift, 10).kind).toBe('trim');
		}
	});

	it('only seeks once the guide is genuinely lost', () => {
		expect(guideCorrection(10 + GUIDE_RESEEK_SEC + 0.01, 10).kind).toBe('reseek');
		expect(guideCorrection(12, 10).kind).toBe('reseek');
		// A seek returns to neutral tempo; leaving a trim on after a reseek would fight the next tick.
		expect(guideCorrection(12, 10).rate).toBe(1);
	});
});

describe('guideCorrection — the trim converges in the right direction', () => {
	it('slows a guide that is ahead', () => {
		expect(guideCorrection(10.1, 10).rate).toBeLessThan(1);
	});

	it('speeds up a guide that is behind', () => {
		expect(guideCorrection(9.9, 10).rate).toBeGreaterThan(1);
	});

	it('never exceeds the trim ceiling, so the stretcher stays transparent', () => {
		for (const drift of [0.05, 0.1, 0.2, GUIDE_RESEEK_SEC - 0.005]) {
			for (const signed of [drift, -drift]) {
				const { rate } = guideCorrection(10 + signed, 10);
				expect(Math.abs(rate - 1)).toBeLessThanOrEqual(GUIDE_MAX_RATE_TRIM + 1e-9);
			}
		}
	});

	it('is symmetric — the same drift either way asks for the same magnitude of trim', () => {
		const ahead = guideCorrection(10.1, 10).rate;
		const behind = guideCorrection(9.9, 10).rate;
		expect(Math.abs(ahead - 1)).toBeCloseTo(Math.abs(behind - 1), 12);
	});
});

describe('guideCorrection — degenerate playheads', () => {
	it('holds on a non-finite playhead rather than seeking on a guess', () => {
		expect(guideCorrection(NaN, 10).kind).toBe('hold');
		expect(guideCorrection(10, NaN).kind).toBe('hold');
		expect(guideCorrection(Infinity, 10).kind).toBe('hold');
	});
});
