// How long a song still has to cook, from THIS box's own history (proposal 05). Pure — the hub reads the
// ledger and hands the rows in. AN ETA IS A CLAIM (`phrasing/position-sentence.ts`), so every gap returns null
// rather than a guess: a box with no finished run of a step says nothing about that step, and the card says
// nothing at all.

import type { JobType } from '../../contract';

/** One finished attempt, as the ledger keeps it. */
export interface FinishedRun {
	startedAt: number | null;
	finishedAt: number | null;
	audioSec: number | null;
}

/** How many recent runs the median is taken over: enough to shrug off one slow song, few enough to follow a
 *  box whose load changed tonight. */
export const ETA_SAMPLE = 10;

/** The steps a process still has to run after `jobType`, in order. `stems-upgrade` is its own process. */
export function laterSteps(jobType: JobType): JobType[] {
	if (jobType === 'fetch') return ['stems', 'align'];
	if (jobType === 'stems') return ['align'];
	return [];
}

/** Seconds of work per second of audio: the median over `runs`, or null when none is usable. */
export function workPerAudioSec(runs: readonly FinishedRun[]): number | null {
	const rates = runs
		.filter((r) => r.startedAt != null && r.finishedAt != null && r.audioSec != null && r.audioSec > 0)
		.map((r) => (r.finishedAt! - r.startedAt!) / 1000 / r.audioSec!)
		.filter((rate) => Number.isFinite(rate) && rate >= 0)
		.sort((a, b) => a - b);
	if (rates.length === 0) return null;
	const mid = rates.length >> 1;
	return rates.length % 2 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;
}

/**
 * Whole seconds until the song is ready: what is left of the running step, plus every later step in full.
 * Null when the song's length, or any step's rate, is unknown. An overrun reads 0 ("under a minute"), never a
 * negative number and never a step that has already overrun stretching the ones after it.
 */
export function etaSec(opts: {
	audioSec: number | null | undefined;
	elapsedSec: number;
	current: number | null;
	later: readonly (number | null)[];
}): number | null {
	const { audioSec, elapsedSec, current, later } = opts;
	if (audioSec == null || !(audioSec > 0) || current == null || later.some((r) => r == null)) return null;
	const left = Math.max(0, current * audioSec - Math.max(0, elapsedSec));
	return Math.round(left + later.reduce<number>((sum, r) => sum + r! * audioSec, 0));
}
