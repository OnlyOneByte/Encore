// The ETA is a CLAIM, so the cases that matter are the ones where it must say nothing, and the overrun.
import { test, expect } from 'bun:test';
import {
	ETA_OVERDUE,
	engineFamily,
	etaSec,
	laterSteps,
	overdueAfterSec,
	sameEngine,
	workPerAudioSec,
	type FinishedRun
} from '$lib/server/jobs/eta';

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

test('a small overrun reads 0 and does not stretch the later steps', () => {
	// 100 s expected; 150 s is inside the minute's grace.
	expect(etaSec({ audioSec: 200, elapsedSec: 150, current: 0.5, later: [] })).toBe(0);
	expect(etaSec({ audioSec: 200, elapsedSec: 150, current: 0.5, later: [0.1] })).toBe(20);
});

test('a minute past the estimate it is OVERDUE, so the card stops promising "under a minute"', () => {
	expect(etaSec({ audioSec: 200, elapsedSec: 161, current: 0.5, later: [0.1] })).toBe(ETA_OVERDUE);
	// The same minute on a long step: 1000 s expected, overdue past 1060 s, not 5 minutes later.
	expect(overdueAfterSec(1000)).toBe(1060);
	expect(etaSec({ audioSec: 2000, elapsedSec: 1060, current: 0.5, later: [] })).toBe(0);
	expect(etaSec({ audioSec: 2000, elapsedSec: 1061, current: 0.5, later: [] })).toBe(ETA_OVERDUE);
});

test('history is matched on the engine FAMILY and the model', () => {
	const runs: FinishedRun[] = [
		{ ...run(50), engine: 'demucs-mlx', model: 'htdemucs' },
		{ ...run(50), engine: 'audiosep:bs-roformer', model: 'bs-roformer' },
		{ ...run(50), engine: 'demucs', model: 'htdemucs_ft' }
	];
	expect(sameEngine(runs, 'demucs', 'htdemucs')).toEqual([runs[0]!]);
	expect(sameEngine(runs, 'audiosep', 'bs-roformer')).toEqual([runs[1]!]);
	expect(sameEngine(runs, 'roformer', 'bs-1')).toEqual([]);
	expect(engineFamily('demucs-mlx')).toBe('demucs');
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
