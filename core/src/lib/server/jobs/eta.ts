// How long a song still has to cook, from this room's own history (proposal 05). Pure — the hub reads the
// ledger and hands the rows in. AN ETA IS A CLAIM (`phrasing/position-sentence.ts`), so every gap returns null
// rather than a guess: a box with no finished run of a step says nothing about that step, and the card says
// nothing at all.

import type { JobType } from '../../contract';

/** One finished attempt, as the ledger keeps it. */
export interface FinishedRun {
	startedAt: number | null;
	finishedAt: number | null;
	audioSec: number | null;
	engine?: string | null;
	model?: string | null;
}

/** The runs that measure a step on `engine` + `model`: same engine family and the same model. Null-engine steps
 *  (fetch, align) match each other. Nothing matching is no ETA, never another engine's speed. */
export function sameEngine(runs: readonly FinishedRun[], engine: string | null, model: string | null): FinishedRun[] {
	const family = engineFamily(engine);
	return runs.filter((r) => engineFamily(r.engine) === family && (r.model ?? null) === (model ?? null));
}

/** How many recent runs the median is taken over: enough to shrug off one slow song, few enough to follow a
 *  box whose load changed tonight. */
export const ETA_SAMPLE = 10;

/** How many recent runs of a step are read before matching them to the running engine and model. */
export const ETA_WINDOW = 200;

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

/** `etaSec` once the running step is past its estimate: the card says "Taking longer than usual" rather than
 *  "under a minute" for as long as it runs. The one negative value, so the wire needs no new field. */
export const ETA_OVERDUE = -1;

/** The minute an overrun may say "under a minute" for: no longer, or the room watches the claim fail. */
export const OVERDUE_GRACE_SEC = 60;

/** When a step whose estimate is `expectedSec` becomes OVERDUE: one minute past it, however long the step. */
export function overdueAfterSec(expectedSec: number): number {
	return expectedSec + OVERDUE_GRACE_SEC;
}

/**
 * Whole seconds until the song is ready: what is left of the running step, plus every later step in full.
 * Null when the song's length, or any step's rate, is unknown. A small overrun reads 0 ("under a minute") and
 * never stretches the steps after it; past `overdueAfterSec` it is `ETA_OVERDUE`.
 */
export function etaSec(opts: {
	audioSec: number | null | undefined;
	elapsedSec: number;
	current: number | null;
	later: readonly (number | null)[];
}): number | null {
	const { audioSec, elapsedSec, current, later } = opts;
	if (audioSec == null || !(audioSec > 0) || current == null || later.some((r) => r == null)) return null;
	const expected = current * audioSec;
	const elapsed = Math.max(0, elapsedSec);
	if (elapsed > overdueAfterSec(expected)) return ETA_OVERDUE;
	const left = Math.max(0, expected - elapsed);
	return Math.round(left + later.reduce<number>((sum, r) => sum + r! * audioSec, 0));
}

/** The engine FAMILY a run belongs to, so a box's history survives the request and the report naming it
 *  differently: `demucs` asked, `demucs-mlx` reported; `audiosep` asked, `audiosep:<token>` reported. */
export function engineFamily(engine: string | null | undefined): string | null {
	return engine ? engine.split(':')[0]!.replace(/-mlx$/, '') : null;
}
