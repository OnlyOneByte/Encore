// The ETA is a CLAIM, so the cases that matter are the ones where it must say nothing, and the overrun.
import { test, expect } from 'bun:test';
import { etaSec, laterSteps, workPerAudioSec, type FinishedRun } from '$lib/server/jobs/eta';

/** A run that took `sec` seconds of work on `audioSec` seconds of audio. */
const run = (sec: number, audioSec: number | null = 100): FinishedRun => ({
	startedAt: 1_000,
	finishedAt: 1_000 + sec * 1000,
	audioSec
});

test('no history: no rate, and so no ETA — the first song on a new box says nothing', () => {
	expect(workPerAudioSec([])).toBeNull();
	expect(workPerAudioSec([run(50, null), { startedAt: null, finishedAt: 5, audioSec: 100 }])).toBeNull();
	expect(etaSec({ audioSec: 200, elapsedSec: 0, current: null, later: [] })).toBeNull();
});

test('the rate is the MEDIAN, so one slow song does not move it', () => {
	expect(workPerAudioSec([run(50), run(60), run(900)])).toBe(0.6);
	expect(workPerAudioSec([run(50), run(70)])).toBe(0.6);
});

test('with history: what is left of this step plus every later step in full', () => {
	// 200 s of audio; separation at 0.5 s/s with 40 s spent leaves 60 s, then align at 0.1 s/s adds 20 s.
	expect(etaSec({ audioSec: 200, elapsedSec: 40, current: 0.5, later: [0.1] })).toBe(80);
});

test('an overrun reads 0, never negative, and does not stretch the later steps', () => {
	expect(etaSec({ audioSec: 200, elapsedSec: 500, current: 0.5, later: [] })).toBe(0);
	expect(etaSec({ audioSec: 200, elapsedSec: 500, current: 0.5, later: [0.1] })).toBe(20);
});

test('an unknown length, or a later step with no history, is no ETA rather than a short one', () => {
	expect(etaSec({ audioSec: undefined, elapsedSec: 0, current: 0.5, later: [] })).toBeNull();
	expect(etaSec({ audioSec: 0, elapsedSec: 0, current: 0.5, later: [] })).toBeNull();
	expect(etaSec({ audioSec: 200, elapsedSec: 0, current: 0.5, later: [null] })).toBeNull();
});

test('the steps after each job type', () => {
	expect(laterSteps('fetch')).toEqual(['stems', 'align']);
	expect(laterSteps('stems')).toEqual(['align']);
	expect(laterSteps('align')).toEqual([]);
	expect(laterSteps('stems-upgrade')).toEqual([]);
});
