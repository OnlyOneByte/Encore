import { test, expect } from 'bun:test';
import {
	LOUDNESS_CLAMP_N_DB,
	LOUDNESS_MEASURED_FLOOR,
	libraryLoudnessMedian,
	loudnessNormalizationGain
} from '@encore/shared';

// The owner's ruling (2026-09-09), proved by cases that RED on a flipped rule:
//   • N = 6 dB, floor = 8 measured songs, pull down to median + N, attenuate-only, gated by the knob.
// Each `expect` here is chosen so that changing the constant, the comparison direction, the target, or
// the floor flips it — see the per-block comments.

// dB -> linear, the same conversion the implementation uses, so a test asserting a specific gain does
// not silently agree with a bug in that formula: this is derived independently from first principles.
const linear = (db: number) => 10 ** (db / 20);

// A library of >= 8 measured songs whose median is a round number, so the arithmetic is checkable by
// hand. Eleven values, sorted, median is the 6th = -14.
const LIB = [-20, -18, -17, -16, -15, -14, -13, -12, -11, -10, -9];
// median -14, target = median + 6 = -8. A song must be LOUDER than -8 LUFS to be touched.

test('libraryLoudnessMedian: odd count takes the middle value, null/absent ignored', () => {
	expect(libraryLoudnessMedian([-20, -14, -9])).toBe(-14);
	// nulls are not data points — they drop out, leaving the same odd-count median
	expect(libraryLoudnessMedian([-20, null, -14, undefined, -9])).toBe(-14);
});
test('libraryLoudnessMedian: even count is the mean of the two central values', () => {
	expect(libraryLoudnessMedian([-16, -12])).toBe(-14);
});
test('libraryLoudnessMedian: no measurable values -> null (distinct from a real 0 median)', () => {
	expect(libraryLoudnessMedian([])).toBeNull();
	expect(libraryLoudnessMedian([null, undefined])).toBeNull();
});

test('loudnessNormalizationGain — constants match the ruling: N is 6 dB and the floor is 8 songs', () => {
	// Pin the ruling itself: if either constant drifts, the whole suite below shifts and this fails
	// first, naming the constant.
	expect(LOUDNESS_CLAMP_N_DB).toBe(6);
	expect(LOUDNESS_MEASURED_FLOOR).toBe(8);
});

const on = (songLufs: number | null, lib = LIB) =>
	loudnessNormalizationGain({ songLufs, libraryLevels: lib, enabled: true });

test('loudnessNormalizationGain — the outlier clamp: a song EXACTLY at median + N is NOT touched (boundary is inclusive of the band)', () => {
	// -8 == median(-14) + 6. Reds if the comparison were `<` instead of `<=` (would attenuate the
	// boundary song) or if the target were the median instead of median+N.
	const r = on(-8);
	expect(r.gain).toBe(1);
	expect(r.attenuated).toBe(false);
});

test('loudnessNormalizationGain — the outlier clamp: a song <= 6 dB over the median is NOT touched', () => {
	// -9 is 5 dB over the median, inside the band. Reds if N were 3 (would touch it) or the
	// comparison direction were flipped.
	expect(on(-9).gain).toBe(1);
	// a quiet song, far below the median, is likewise untouched — never brought UP
	expect(on(-20).gain).toBe(1);
});

test('loudnessNormalizationGain — the outlier clamp: a song MORE than 6 dB over the median is pulled DOWN to median + N', () => {
	// -4 is 10 dB over the median, 4 dB past the target -8. It should be cut by exactly 4 dB, to -8.
	// gain = 10 ** (-4/20). Reds if pulled to the median (would be a 10 dB cut, gain 10**(-10/20)),
	// or not touched at all, or the cut sign were wrong (a boost).
	const r = on(-4);
	expect(r.attenuated).toBe(true);
	expect(r.gain).toBeCloseTo(linear(-4), 10);
	// the applied gain lands the song at the target: -4 dB + (-4 dB cut) = -8 = median + N
	expect(-4 + 20 * Math.log10(r.gain)).toBeCloseTo(-8, 10);
});

test('loudnessNormalizationGain — the outlier clamp: a very loud outlier is pulled all the way down to the target, never below unity clamp', () => {
	// 0 LUFS (brickwalled) is 8 dB over the target -8, cut by 8 dB. Still a valid (0,1) gain.
	const r = on(0);
	expect(r.gain).toBeCloseTo(linear(-8), 10);
	expect(r.gain).toBeGreaterThan(0);
	expect(r.gain).toBeLessThan(1);
});

test('loudnessNormalizationGain — the outlier clamp: ATTENUATE-ONLY: no input ever produces a gain above unity', () => {
	for (const s of [-40, -20, -14, -8, -7.9, -4, 0, 3]) {
		expect(on(s).gain).toBeLessThanOrEqual(1);
	}
});

test('loudnessNormalizationGain — the floor: below 8 measured songs, nothing is normalized even for a screaming outlier', () => {
	// Seven measured songs (below the floor of 8) + a 0 LUFS outlier that WOULD be pulled down hard
	// above the floor. Reds if the floor were 7 or lower, or absent.
	const sevenLoud = [0, 0, 0, 0, 0, 0, 0];
	const r = loudnessNormalizationGain({ songLufs: 0, libraryLevels: sevenLoud, enabled: true });
	expect(r.gain).toBe(1);
	expect(r.measuredCount).toBe(7);
});

test('loudnessNormalizationGain — the floor: exactly 8 measured songs is enough for the clamp to engage', () => {
	// Eight songs, median 0 (all zero), target 6. A song at 10 is 4 dB over the target -> cut 4 dB.
	// Reds if the floor comparison were `>` instead of `>=` (8 would be rejected).
	const eight = [0, 0, 0, 0, 0, 0, 0, 0];
	const r = loudnessNormalizationGain({ songLufs: 10, libraryLevels: eight, enabled: true });
	expect(r.gain).toBeCloseTo(linear(-4), 10);
	expect(r.attenuated).toBe(true);
});

test('loudnessNormalizationGain — the floor: null-level entries do not count toward the floor', () => {
	// Seven real measurements + three nulls = ten entries but only seven data points, below the
	// floor. Reds if nulls were counted (ten would clear the floor of 8).
	const lib = [0, 0, 0, 0, 0, 0, 0, null, null, null];
	const r = loudnessNormalizationGain({ songLufs: 0, libraryLevels: lib, enabled: true });
	expect(r.gain).toBe(1);
	expect(r.measuredCount).toBe(7);
});

test('loudnessNormalizationGain — never touches an unmeasured song: a null-level song is NEVER gained, even amid a loud measured library', () => {
	// The playing song has no measured level; the library is well over the floor and loud. A null
	// song has nothing to compare, so it plays at unity. Reds if a null song were assumed to be at
	// some default and clamped.
	expect(loudnessNormalizationGain({ songLufs: null, libraryLevels: LIB, enabled: true }).gain).toBe(1);
	expect(loudnessNormalizationGain({ songLufs: undefined, libraryLevels: LIB, enabled: true }).gain).toBe(1);
});

test('loudnessNormalizationGain — the room knob: knob OFF = no normalization, even for a screaming outlier above the floor', () => {
	// The exact input that IS attenuated when enabled (see the outlier block) returns unity here.
	// Reds if the enabled gate were dropped.
	const r = loudnessNormalizationGain({ songLufs: 0, libraryLevels: LIB, enabled: false });
	expect(r.gain).toBe(1);
	expect(r.attenuated).toBe(false);
});

test('loudnessNormalizationGain — the room knob: the SAME input flips between untouched (off) and attenuated (on)', () => {
	const input = { songLufs: 0, libraryLevels: LIB } as const;
	expect(loudnessNormalizationGain({ ...input, enabled: false }).gain).toBe(1);
	expect(loudnessNormalizationGain({ ...input, enabled: true }).gain).toBeLessThan(1);
});
