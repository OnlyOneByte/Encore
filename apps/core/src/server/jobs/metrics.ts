// Metrics rollup — PURE functions over JobAttempt rows. No DB, no dates, no I/O, so every number the
// internal dashboard shows is pinned by a unit test rather than eyeballed on a live box.
//
// The reporting unit is the REALTIME FACTOR (seconds of compute per second of audio), not raw
// seconds. Raw seconds cannot be averaged across a library: a 30-second clip and a 7-minute track are
// different workloads, so a mean over both describes neither. The rate is also directly comparable to
// the `SeparatorCost.rtFactor` values baked into the whitelist, which is what lets this dashboard
// check a benchmarked constant against what the box actually does.

import {
	attemptStages,
	realtimeFactor,
	separatorCost,
	type JobAttempt,
	type JobType,
	type SeparatorCost
} from '@encore/shared';

/** An attempt that ran to completion and can therefore be measured. */
function measurable(a: JobAttempt): boolean {
	return a.outcome === 'ready' && a.startedAt !== null && a.finishedAt !== null;
}

/** Processing time in ms — start of work to finish, excluding every kind of waiting. */
export function processingMs(a: JobAttempt): number | null {
	if (a.startedAt === null || a.finishedAt === null) return null;
	return Math.max(0, a.finishedAt - a.startedAt);
}

/** Time spent waiting in the queue before a worker took it. */
export function queueWaitMs(a: JobAttempt): number | null {
	if (a.assignedAt === null) return null;
	return Math.max(0, a.assignedAt - a.enqueuedAt);
}

/**
 * Nearest-rank percentile on a sorted copy. Nearest-rank rather than interpolated because these
 * samples are tiny — a self-hosted box may have eight cooks total — and an interpolated p95 over
 * eight points invents a value that lies between two real measurements and equals neither.
 */
export function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function mean(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((s, v) => s + v, 0) / values.length;
}

/** How one pipeline step performs. `n` is carried so a reader can see how much to trust the rest. */
export interface StepStats {
	jobType: JobType;
	/** Attempts that completed. The sample size — 3 cooks is an anecdote, not an average. */
	n: number;
	/** Attempts that failed or were abandoned, for the failure rate beside the timings. */
	failed: number;
	abandoned: number;
	meanMs: number | null;
	p50Ms: number | null;
	p95Ms: number | null;
	meanQueueWaitMs: number | null;
	/** Seconds of compute per second of audio. The comparable number. */
	meanRtFactor: number | null;
}

/** Per-step rollup, ordered by the pipeline's own sequence rather than alphabetically. */
const STEP_ORDER: JobType[] = ['fetch', 'stems', 'align', 'stems-upgrade'];

export function perStep(attempts: JobAttempt[]): StepStats[] {
	const byType = new Map<JobType, JobAttempt[]>();
	for (const a of attempts) {
		const list = byType.get(a.jobType) ?? [];
		list.push(a);
		byType.set(a.jobType, list);
	}
	const out: StepStats[] = [];
	for (const jobType of STEP_ORDER) {
		const all = byType.get(jobType);
		if (!all || all.length === 0) continue;
		const done = all.filter(measurable);
		const durations = done.map((a) => processingMs(a)!).filter((v) => Number.isFinite(v));
		const waits = all.map(queueWaitMs).filter((v): v is number => v !== null);
		const rts = done.map(realtimeFactor).filter((v): v is number => v !== null);
		out.push({
			jobType,
			n: done.length,
			failed: all.filter((a) => a.outcome === 'failed').length,
			abandoned: all.filter((a) => a.outcome === 'abandoned').length,
			meanMs: mean(durations),
			p50Ms: percentile(durations, 50),
			p95Ms: percentile(durations, 95),
			meanQueueWaitMs: mean(waits),
			meanRtFactor: mean(rts)
		});
	}
	return out;
}

/** How long a whole cook took, from the moment it was requested to a singable song. */
export interface CookStats {
	cookId: string;
	mediaId: string;
	/** Enqueue of the first step → finish of the last. What a singer actually waited. */
	totalMs: number;
	/** The sum of the steps' processing time. Below totalMs by however long it queued. */
	workMs: number;
	steps: number;
	complete: boolean;
	/**
	 * TRUE when this cook straddles the older edge of the read window, so some earlier steps may
	 * have finished before the window opened and were never fetched. Its span is then UNDER-counted
	 * (measured from the earliest surviving step) and its completeness cannot be trusted, so it is
	 * never reported as complete and the aggregate refuses to count it (#472).
	 */
	clipped: boolean;
}

/**
 * One row per cook. Only cooks whose every attempt is sealed are reported: a cook still in flight has
 * no end, and treating "now" as its end would report a falling duration as it runs.
 */
export function perCook(attempts: JobAttempt[], windowStartMs: number | null = null): CookStats[] {
	const byCook = new Map<string, JobAttempt[]>();
	for (const a of attempts) {
		if (!a.cookId) continue; // rows written before cook ids existed cannot be grouped
		const list = byCook.get(a.cookId) ?? [];
		list.push(a);
		byCook.set(a.cookId, list);
	}
	const out: CookStats[] = [];
	for (const [cookId, list] of byCook) {
		const sealed = list.filter((a) => a.finishedAt !== null);
		if (sealed.length === 0) continue;
		const start = Math.min(...sealed.map((a) => a.enqueuedAt));
		const end = Math.max(...sealed.map((a) => a.finishedAt!));
		// A cook enqueued before the window opened may be missing its earliest steps: its span is then
		// measured from the wrong start and its completeness cannot be trusted. Flag it, never complete.
		const clipped = windowStartMs !== null && start < windowStartMs;
		const complete = !clipped && sealed.length === list.length && sealed.every((a) => a.outcome === 'ready');
		out.push({
			cookId,
			mediaId: sealed[0].mediaId,
			totalMs: Math.max(0, end - start),
			workMs: sealed.reduce((s, a) => s + (processingMs(a) ?? 0), 0),
			steps: sealed.length,
			complete,
			clipped
		});
	}
	return out.sort((a, b) => b.totalMs - a.totalMs);
}

/** Aggregate end-to-end, over COMPLETE cooks only. */
export function e2e(
	attempts: JobAttempt[],
	windowStartMs: number | null = null
): { n: number; meanMs: number | null; p50Ms: number | null; p95Ms: number | null } {
	// A clipped boundary cook is not complete, so it never enters this aggregate (#472).
	const totals = perCook(attempts, windowStartMs)
		.filter((c) => c.complete)
		.map((c) => c.totalMs);
	return { n: totals.length, meanMs: mean(totals), p50Ms: percentile(totals, 50), p95Ms: percentile(totals, 95) };
}

/**
 * Measured cost of one engine+model, next to what the whitelist CLAIMS it costs.
 *
 * This comparison is the reason the dashboard is worth building. `SeparatorCost.rtFactor` was
 * benchmarked once on a 32-core Graviton 3 and has never been checked against a real deployment, and
 * several entries are marked `provenance: 'estimated'` outright. `AsrModel` goes further and refuses
 * to carry an rtFactor at all, with a comment saying not to add one until someone times these on the
 * target hardware. This is that measurement.
 */
export interface ModelStats {
	engine: string | null;
	model: string | null;
	n: number;
	meanRtFactor: number | null;
	p95RtFactor: number | null;
	meanMs: number | null;
	/** The whitelist's claim, when this pair is in it. */
	declared: SeparatorCost | undefined;
	/**
	 * measured ÷ declared. 1.0 = the benchmark holds on this box. Null when either side is unknown.
	 * Deliberately a ratio and not a pass/fail: a box slower than a 32-core Graviton is expected, and
	 * the useful signal is HOW MUCH slower, which is what sizing a party needs.
	 */
	ratioToDeclared: number | null;
}

export function perModel(attempts: JobAttempt[]): ModelStats[] {
	const groups = new Map<string, JobAttempt[]>();
	for (const a of attempts) {
		if (!measurable(a)) continue;
		if (!a.model && !a.engine) continue; // a step with no model axis (a fetch) is not a model row
		const key = `${a.engine ?? ''}\u0000${a.model ?? ''}`;
		const list = groups.get(key) ?? [];
		list.push(a);
		groups.set(key, list);
	}
	const out: ModelStats[] = [];
	for (const list of groups.values()) {
		const rts = list.map(realtimeFactor).filter((v): v is number => v !== null);
		const declared = list[0].engine && list[0].model ? separatorCost(list[0].engine, list[0].model) : undefined;
		const measured = mean(rts);
		out.push({
			engine: list[0].engine,
			model: list[0].model,
			n: list.length,
			meanRtFactor: measured,
			p95RtFactor: percentile(rts, 95),
			meanMs: mean(list.map((a) => processingMs(a)!)),
			declared,
			ratioToDeclared: measured !== null && declared ? measured / declared.rtFactor : null
		});
	}
	return out.sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
}

/** The lyrics axis, which has no declared cost to compare against — this IS the first measurement. */
export interface AsrStats {
	asrModel: string | null;
	syncMode: string | null;
	n: number;
	meanRtFactor: number | null;
	meanMs: number | null;
}

export function perAsrModel(attempts: JobAttempt[]): AsrStats[] {
	const groups = new Map<string, JobAttempt[]>();
	for (const a of attempts) {
		if (!measurable(a) || !a.asrModel) continue;
		const key = `${a.asrModel}\u0000${a.syncMode ?? ''}`;
		const list = groups.get(key) ?? [];
		list.push(a);
		groups.set(key, list);
	}
	return [...groups.values()]
		.map((list) => ({
			asrModel: list[0].asrModel,
			syncMode: list[0].syncMode,
			n: list.length,
			meanRtFactor: mean(list.map(realtimeFactor).filter((v): v is number => v !== null)),
			meanMs: mean(list.map((a) => processingMs(a)!))
		}))
		.sort((a, b) => b.n - a.n);
}

/** Mean ms per named sub-step, from the worker's reported breakdown. */
export function perStage(attempts: JobAttempt[]): { stage: string; n: number; meanMs: number | null }[] {
	const groups = new Map<string, number[]>();
	for (const a of attempts) {
		for (const s of attemptStages(a)) {
			const list = groups.get(s.stage) ?? [];
			list.push(s.ms);
			groups.set(s.stage, list);
		}
	}
	return [...groups.entries()]
		.map(([stage, ms]) => ({ stage, n: ms.length, meanMs: mean(ms) }))
		.sort((a, b) => (b.meanMs ?? 0) - (a.meanMs ?? 0));
}

/**
 * Whether a set of measurements is worth quoting as an average.
 *
 * Stated as data rather than left to the reader because the failure mode is specific and likely: this
 * runs on a box with a handful of cooked songs, where a "mean" over two samples reads with exactly the
 * same authority as one over two hundred. The UI uses this to label a number as provisional.
 */
export const CONFIDENT_SAMPLE = 10;

export function isAnecdote(n: number): boolean {
	return n < CONFIDENT_SAMPLE;
}
