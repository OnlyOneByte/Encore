// PURE functions over JobAttempt rows — no DB, no dates, no I/O, so every number the dashboard shows
// is pinned by a unit test. Reports in REALTIME FACTOR (compute-seconds per audio-second), not raw
// seconds, since raw seconds can't be averaged across a library of different-length tracks and the
// rate is directly comparable to the `SeparatorCost.rtFactor` values baked into the whitelist.

import {
	attemptStages,
	realtimeFactor,
	separatorCost,
	type JobAttempt,
	type JobType,
	type SeparatorCost
} from '../../contract';

/** An attempt that ran to completion and can therefore be measured. */
function measurable(a: JobAttempt): boolean {
	return a.outcome === 'ready' && a.startedAt !== null && a.finishedAt !== null;
}

/** Bucket by a derived key, FIRST-SEEN key order preserved — every rollup below either walks its own key
 *  order or sorts, so the order only settles ties. A null/undefined key is NOT grouped: several rollups
 *  have rows carrying no axis to group on (a row written before process ids existed has no process). */
function groupBy<T, K>(items: Iterable<T>, keyOf: (item: T) => K | null | undefined): Map<K, T[]> {
	const out = new Map<K, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		if (key === null || key === undefined) continue;
		const list = out.get(key);
		if (list) list.push(item);
		else out.set(key, [item]);
	}
	return out;
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

/** Nearest-rank percentile, not interpolated: samples are tiny (a self-hosted box may have eight
 *  processes total) and an interpolated p95 over eight points would invent a value nothing measured. */
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
	/** Attempts that completed. The sample size — 3 processes is an anecdote, not an average. */
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
	const byType = groupBy(attempts, (a) => a.jobType);
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

/** How long a whole process took, from the moment it was requested to a singable song. */
export interface ProcessStats {
	processingId: string;
	mediaId: string;
	/** Enqueue of the first step → finish of the last. What a singer actually waited. */
	totalMs: number;
	/** The sum of the steps' processing time. Below totalMs by however long it queued. */
	workMs: number;
	steps: number;
	complete: boolean;
	/** TRUE when this process straddles the read window's older edge, so earlier steps may be missing
	 *  and its span is UNDER-counted; such a process is never reported `complete`. */
	clipped: boolean;
}

/** One row per process. Only processes whose every attempt is sealed are reported — a process still
 *  in flight has no end, and "now" as its end would report a shrinking duration as it runs. */
export function perProcess(attempts: JobAttempt[], windowStartMs: number | null = null): ProcessStats[] {
	// `|| null` so a row written before process ids existed is skipped rather than bucketed under ''.
	const byProcess = groupBy(attempts, (a) => a.processingId || null);
	const out: ProcessStats[] = [];
	for (const [processingId, list] of byProcess) {
		const sealed = list.filter((a) => a.finishedAt !== null);
		if (sealed.length === 0) continue;
		const start = Math.min(...sealed.map((a) => a.enqueuedAt));
		const end = Math.max(...sealed.map((a) => a.finishedAt!));
		const clipped = windowStartMs !== null && start < windowStartMs;
		const complete = !clipped && sealed.length === list.length && sealed.every((a) => a.outcome === 'ready');
		out.push({
			processingId,
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

/** Aggregate end-to-end, over COMPLETE processes only. */
export function e2e(
	attempts: JobAttempt[],
	windowStartMs: number | null = null
): { n: number; meanMs: number | null; p50Ms: number | null; p95Ms: number | null } {
	const totals = perProcess(attempts, windowStartMs)
		.filter((c) => c.complete)
		.map((c) => c.totalMs);
	return { n: totals.length, meanMs: mean(totals), p50Ms: percentile(totals, 50), p95Ms: percentile(totals, 95) };
}

/** Measured cost of one engine+model, next to what the whitelist CLAIMS it costs — checking a
 *  benchmarked constant (some entries `provenance: 'estimated'`) against what this box actually does. */
export interface ModelStats {
	engine: string | null;
	model: string | null;
	n: number;
	meanRtFactor: number | null;
	p95RtFactor: number | null;
	meanMs: number | null;
	/** The whitelist's claim, when this pair is in it. */
	declared: SeparatorCost | undefined;
	/** measured ÷ declared; 1.0 = benchmark holds, null if either side is unknown. A ratio, not a
	 *  pass/fail, because a slower box is expected — HOW MUCH slower is the signal sizing a party needs. */
	ratioToDeclared: number | null;
}

export function perModel(attempts: JobAttempt[]): ModelStats[] {
	// A step with no model axis (a fetch) is not a model row.
	const groups = groupBy(
		attempts.filter((a) => measurable(a) && (!!a.model || !!a.engine)),
		(a) => `${a.engine ?? ''}\u0000${a.model ?? ''}`
	);
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
	const groups = groupBy(
		attempts.filter((a) => measurable(a) && !!a.asrModel),
		(a) => `${a.asrModel}\u0000${a.syncMode ?? ''}`
	);
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
	const groups = groupBy(
		attempts.flatMap((a) => attemptStages(a)),
		(s) => s.stage
	);
	return [...groups.entries()]
		.map(([stage, reported]) => ({ stage, n: reported.length, meanMs: mean(reported.map((s) => s.ms)) }))
		.sort((a, b) => (b.meanMs ?? 0) - (a.meanMs ?? 0));
}

/** Whether a set of measurements is worth quoting as an average — a mean over two self-hosted samples
 *  otherwise reads with the same authority as one over two hundred. The UI labels below this as provisional. */
export const CONFIDENT_SAMPLE = 10;

export function isAnecdote(n: number): boolean {
	return n < CONFIDENT_SAMPLE;
}
