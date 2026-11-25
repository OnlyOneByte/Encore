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
	// Clamped into [0, length-1] over a list the guard above proved non-empty, so this read cannot miss.
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
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
const STEP_ORDER: JobType[] = ['fetch', 'stems', 'align', 'stems-upgrade', 'stems-remake'];

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

/** The last attempt of each job, so a retry stands in for the attempt it replaced. */
function lastAttempts(list: JobAttempt[]): JobAttempt[] {
	return [...groupBy(list, (a) => a.jobId).values()].map((tries) =>
		tries.reduce((x, y) => (y.attempt > x.attempt ? y : x))
	);
}

/** A pick reached ready: it separated, and its final align ended ready. The ledger is read as sealed rows only,
 *  so a song still in flight fails on its missing align, and a lyrics-only re-align on its missing stems. */
export function pickReachedReady(list: JobAttempt[]): boolean {
	const last = lastAttempts(list);
	const ready = (t: JobType) => last.some((a) => a.jobType === t && a.outcome === 'ready');
	return ready('stems') && ready('align');
}

/** One row per process with a sealed attempt. Only a `complete` one is a measured pick to ready. */
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
		// end <= start is a clock that jumped back: no duration to report.
		const complete = !clipped && end > start && pickReachedReady(sealed);
		out.push({
			processingId,
			// `sealed` is non-empty from the guard above, and every attempt in one process names the same media.
			mediaId: sealed[0]!.mediaId,
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
		// `groupBy` seeds each group with its first item, so no group is ever empty. Read once rather than five
		// times: the whole group shares the engine/model pair it was keyed on, so any member answers for it.
		const sample = list[0]!;
		const declared = sample.engine && sample.model ? separatorCost(sample.engine, sample.model) : undefined;
		const measured = mean(rts);
		out.push({
			engine: sample.engine,
			model: sample.model,
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
			// Non-empty by construction in `groupBy`, and the group shares the pair it was keyed on.
			asrModel: list[0]!.asrModel,
			syncMode: list[0]!.syncMode,
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

/** One song that reached ready, as goal 2 measures it: pick to ready as a multiple of the song's length. */
export interface ReadySong {
	processingId: string;
	mediaId: string;
	/** The worker that ran the stems step, the one that sets the pace. */
	workerId: string | null;
	device: string | null;
	threads: number | null;
	audioSec: number;
	totalMs: number;
	/** totalMs ÷ song length. */
	multiple: number;
	/** Where totalMs went. `waitMs` is the rest: queueing, gaps between steps and abandoned retries. */
	waitMs: number;
	fetchMs: number;
	stemsMs: number;
	alignMs: number;
}

/** Picks that reached ready (`pickReachedReady`), plus how many of those could not be measured. */
export interface ReadySongs {
	songs: ReadySong[];
	/** Reached ready with no known song length, so no multiple. */
	noLength: number;
	/** Reached ready with a finish at or before its start: the clock jumped back. */
	badClock: number;
}

/** A retried song counts, its retry time included; a failed one never does. See docs/SERVER.md#the-host-speed-page. */
export function readySongs(attempts: JobAttempt[], windowStartMs: number | null = null): ReadySongs {
	const out: ReadySongs = { songs: [], noLength: 0, badClock: 0 };
	for (const [processingId, all] of groupBy(attempts, (a) => a.processingId || null)) {
		const list = all.filter((a) => a.finishedAt !== null);
		if (list.length === 0 || !pickReachedReady(list)) continue;
		const start = Math.min(...list.map((a) => a.enqueuedAt));
		if (windowStartMs !== null && start < windowStartMs) continue;
		const audioSec = Math.max(0, ...list.map((a) => a.audioSec ?? 0));
		if (audioSec <= 0) {
			out.noLength++;
			continue;
		}
		const totalMs = Math.max(...list.map((a) => a.finishedAt!)) - start;
		if (totalMs <= 0) {
			out.badClock++;
			continue;
		}
		const last = lastAttempts(list);
		const stepMs = (t: JobType) => last.filter((a) => a.jobType === t).reduce((s, a) => s + (processingMs(a) ?? 0), 0);
		const [fetchMs, stemsMs, alignMs] = [stepMs('fetch'), stepMs('stems'), stepMs('align')];
		// pickReachedReady guarantees a stems attempt, the step that sets the pace.
		const pace = last.find((a) => a.jobType === 'stems')!;
		out.songs.push({
			processingId,
			mediaId: list[0]!.mediaId,
			workerId: pace.workerId,
			device: pace.device,
			threads: pace.threads,
			audioSec,
			totalMs,
			multiple: totalMs / 1000 / audioSec,
			waitMs: Math.max(0, totalMs - fetchMs - stemsMs - alignMs),
			fetchMs,
			stemsMs,
			alignMs
		});
	}
	return out;
}

export interface SpeedStats {
	n: number;
	p50Multiple: number | null;
	p90Multiple: number | null;
	/** The typical song's length, so the multiple can be said in minutes too. */
	p50AudioSec: number | null;
}

export function speed(songs: ReadySong[]): SpeedStats {
	const multiples = songs.map((s) => s.multiple);
	return {
		n: songs.length,
		p50Multiple: percentile(multiples, 50),
		p90Multiple: percentile(multiples, 90),
		p50AudioSec: percentile(
			songs.map((s) => s.audioSec),
			50
		)
	};
}

export interface DeviceStats extends SpeedStats {
	workerId: string | null;
	device: string | null;
	threads: number | null;
	/** Mean ms per segment of a song on this machine; they sum to the mean pick-to-ready time. */
	meanWaitMs: number | null;
	meanFetchMs: number | null;
	meanStemsMs: number | null;
	meanAlignMs: number | null;
}

/** One row per machine, keyed on worker, device and threads, fastest first. */
export function perDevice(songs: ReadySong[]): DeviceStats[] {
	const groups = groupBy(songs, (s) => `${s.workerId ?? ''}\u0000${s.device ?? ''}\u0000${s.threads ?? ''}`);
	return [...groups.values()]
		.map((list) => ({
			...speed(list),
			workerId: list[0]!.workerId,
			device: list[0]!.device,
			threads: list[0]!.threads,
			meanWaitMs: mean(list.map((s) => s.waitMs)),
			meanFetchMs: mean(list.map((s) => s.fetchMs)),
			meanStemsMs: mean(list.map((s) => s.stemsMs)),
			meanAlignMs: mean(list.map((s) => s.alignMs))
		}))
		.sort((a, b) => (a.p50Multiple ?? Infinity) - (b.p50Multiple ?? Infinity));
}

export const ERROR_CLASSES = [
	'rate-limited',
	'removed',
	'hung',
	'worker-lost',
	'silent',
	'out-of-memory',
	'other'
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

// First match wins, so the specific causes sit above the broad ones.
const ERROR_PATTERNS: [ErrorClass, RegExp][] = [
	['silent', /digital silence/i],
	['out-of-memory', /out of memory|cannot allocate memory|failed to allocate/i],
	['hung', /stopped as hung/i],
	['worker-lost', /worker died|lease expired/i],
	['rate-limited', /\b429\b|too many requests|rate.?limit/i],
	['removed', /video unavailable|private video|been removed|no longer available|copyright|terms of service/i]
];

export function classifyError(error: string | null): ErrorClass {
	if (!error) return 'other';
	return ERROR_PATTERNS.find(([, re]) => re.test(error))?.[0] ?? 'other';
}

export interface FailureStats {
	cause: ErrorClass;
	/** Distinct songs, since one song can fail on several attempts. */
	songs: number;
	attempts: number;
	lastSeenAt: number;
	/** The newest message, cut short, so an `other` can still be read. */
	lastError: string | null;
}

/** Failed attempts grouped by cause, most songs first. Abandoned attempts were retried, so they are not here. */
export function failures(attempts: JobAttempt[]): FailureStats[] {
	const groups = groupBy(
		attempts.filter((a) => a.outcome === 'failed'),
		(a) => classifyError(a.error)
	);
	return [...groups.entries()]
		.map(([cause, list]) => {
			const newest = list.reduce((x, y) => ((y.finishedAt ?? 0) > (x.finishedAt ?? 0) ? y : x));
			return {
				cause,
				songs: new Set(list.map((a) => a.mediaId)).size,
				attempts: list.length,
				lastSeenAt: newest.finishedAt ?? 0,
				lastError: newest.error ? newest.error.slice(0, 200) : null
			};
		})
		.sort((a, b) => b.songs - a.songs || b.lastSeenAt - a.lastSeenAt);
}

const CSV_COLUMNS = [
	'id',
	'jobId',
	'mediaId',
	'processingId',
	'jobType',
	'attempt',
	'workerId',
	'enqueuedAt',
	'assignedAt',
	'startedAt',
	'finishedAt',
	'outcome',
	'error',
	'engine',
	'model',
	'backend',
	'device',
	'threads',
	'concurrency',
	'demucsJobs',
	'handSet',
	'asrModel',
	'syncMode',
	'audioSec'
] as const satisfies readonly (keyof JobAttempt)[];

function csvCell(v: unknown): string {
	if (v === null || v === undefined) return '';
	let s = String(v);
	// A leading = + - @ makes a spreadsheet run the cell as a formula; error text comes from tools we don't control.
	if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The attempts as CSV, one row each, times in epoch ms. */
export function attemptsCsv(attempts: JobAttempt[]): string {
	const rows = attempts.map((a) => CSV_COLUMNS.map((c) => csvCell(a[c])).join(','));
	return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

/** Whether a set of measurements is worth quoting as an average — a mean over two self-hosted samples
 *  otherwise reads with the same authority as one over two hundred. The UI labels below this as provisional. */
export const CONFIDENT_SAMPLE = 10;

export function isAnecdote(n: number): boolean {
	return n < CONFIDENT_SAMPLE;
}
