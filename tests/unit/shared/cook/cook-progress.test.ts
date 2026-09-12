import { expect, it } from 'bun:test';
import { MEDIA_STAGES, type MediaStatus } from '$lib/contract';
import { overallCookPct } from '$lib/cook-progress';

// The processing bar scaled the WHOLE bar by the current step's own 0-100, so every step
// reaching 100% filled the bar while three of five milestones had not started. overallCookPct maps
// the per-step pct into a per-stage band over MEDIA_STAGES, so the bar reads OVERALL cook completion.
// The defect's exact "done-when": the bar reaches 100% IF AND ONLY IF status === 'ready'.
it('overallCookPct reaches 100 only when ready — a mid-stage step at pct 100 does not fill the bar', () => {
	expect(overallCookPct('ready', 0)).toBe(100);
	expect(overallCookPct('ready', 100)).toBe(100);
	// The exact reported symptom: an early step reporting 100% must NOT read as done.
	expect(overallCookPct('downloading', 100)).toBeLessThan(100);
	expect(overallCookPct('separating', 100)).toBeLessThan(100);
	expect(overallCookPct('aligning', 100)).toBeLessThan(100);
});

it('overallCookPct is monotonic across a full cook — never moves backward at a stage change', () => {
	// Reaching the end of one stage (pct 100) must be <= the start of the next stage (pct 0).
	const inFlight: MediaStatus[] = ['queued', 'downloading', 'separating', 'aligning'];
	for (let i = 0; i < inFlight.length - 1; i++) {
		const endOfStage = overallCookPct(inFlight[i]!, 100);
		const startOfNext = overallCookPct(inFlight[i + 1]!, 0);
		expect(endOfStage).toBeLessThanOrEqual(startOfNext);
	}
	// And the last in-flight stage at 100 must not exceed ready.
	expect(overallCookPct('aligning', 100)).toBeLessThanOrEqual(overallCookPct('ready', 0));
});

it('overallCookPct is monotonic within a stage — pct rising never lowers the bar', () => {
	for (const status of MEDIA_STAGES) {
		let prev = -1;
		for (const pct of [0, 25, 50, 75, 100]) {
			const v = overallCookPct(status, pct);
			expect(v).toBeGreaterThanOrEqual(prev);
			prev = v;
		}
	}
});

it('overallCookPct weights separation heaviest — its band is the widest of the in-flight stages', () => {
	const band = (s: MediaStatus) => overallCookPct(s, 100) - overallCookPct(s, 0);
	expect(band('separating')).toBeGreaterThan(band('downloading'));
	expect(band('separating')).toBeGreaterThan(band('aligning'));
});

// Every in-flight stage must own a NON-ZERO band. A collapsed band means the bar STOPS MOVING for
// the whole of that stage while the worker reports 0→100 on it — the same "bar lies about the cook"
// class this module was written to kill, in the opposite direction. The BAND_END table is
// hand-tuned and explicitly invites re-weighting (see the docstring), so pin the floor per stage:
// verified RED per-band (queued/downloading/aligning each collapse alone with the suite otherwise
// green; separating was only caught incidentally by the widest-band ordering above).
it('overallCookPct: every in-flight stage owns a non-zero band — no stage freezes the bar', () => {
	const band = (s: MediaStatus) => overallCookPct(s, 100) - overallCookPct(s, 0);
	for (const s of MEDIA_STAGES) if (s !== 'ready') expect(band(s)).toBeGreaterThan(0);
});

it('overallCookPct: terminal non-line exits do not read as complete', () => {
	// failed / canceled are off the line (mediaStagePosition -1). The bar must not claim 100.
	expect(overallCookPct('failed', 50)).toBeLessThan(100);
	expect(overallCookPct('canceled', 50)).toBeLessThan(100);
});

it('overallCookPct clamps a malformed per-step pct into range', () => {
	expect(overallCookPct('separating', -10)).toBe(overallCookPct('separating', 0));
	expect(overallCookPct('separating', 250)).toBe(overallCookPct('separating', 100));
});

// The readout the user actually sees is Math.round(pct). The iff must hold on the ROUNDED value,
// not just the raw one: a band top of e.g. 99.6 rounds to 100 and would print "100%" mid-cook while
// every raw-value test stays green. Pin the rounded readout so the top-of-band value can't drift up.
it('overallCookPct: the rounded readout reaches 100 only when ready', () => {
	expect(Math.round(overallCookPct('aligning', 100))).toBeLessThan(100);
	expect(Math.round(overallCookPct('separating', 100))).toBeLessThan(100);
	expect(Math.round(overallCookPct('downloading', 100))).toBeLessThan(100);
	expect(Math.round(overallCookPct('ready', 0))).toBe(100);
});

// A non-finite per-step pct (NaN from a bad worker frame, Infinity) must not poison the bar: scaleX
// (NaN) is silently ignored so the bar would freeze at its previous fill, and the readout would print
// "NaN%". It should read the band floor instead.
it('overallCookPct: a non-finite per-step pct reads as the band floor, not NaN', () => {
	expect(overallCookPct('separating', Number.NaN)).toBe(overallCookPct('separating', 0));
	expect(overallCookPct('separating', Number.POSITIVE_INFINITY)).toBe(overallCookPct('separating', 0));
	expect(Number.isFinite(overallCookPct('separating', Number.NaN))).toBe(true);
});
