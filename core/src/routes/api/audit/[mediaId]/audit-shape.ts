// The shape of the audit response, extracted from +server.ts so it can be exported and unit-tested — a SvelteKit +server.ts may only export HTTP method handlers.
import {
	attemptHandSet,
	attemptStages,
	attemptSelection,
	realtimeFactor,
	type JobAttempt,
	type SelectionRecord
} from '$lib/contract';
import { processingMs, queueWaitMs } from '$lib/server/jobs/metrics';

export interface AuditAttempt {
	id: string;
	jobType: string;
	attempt: number;
	outcome: string | null;
	error: string | null;
	workerId: string | null;
	enqueuedAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	queueWaitMs: number | null;
	processingMs: number | null;
	rtFactor: number | null;
	models: {
		engine: string | null;
		model: string | null;
		backend: string | null;
		device: string | null;
		threads: string | null;
		concurrency: string | null;
		demucsJobs: string | null;
		asrModel: string | null;
		syncMode: string | null;
	};
	/** Which of the worker's profile settings were set by hand; null when it did not say. */
	handSet: string[] | null;
	stages: { stage: string; ms: number }[];
	// WHY this lyric won, when the attempt recorded it. Null on every non-align attempt.
	selection: SelectionRecord | null;
}

export function groupProcesses(attempts: JobAttempt[]) {
	const byProcess = new Map<string, JobAttempt[]>();
	for (const a of attempts) {
		const key = a.processingId || '(pre-ledger)';
		const list = byProcess.get(key) ?? [];
		list.push(a);
		byProcess.set(key, list);
	}
	return [...byProcess.entries()]
		.map(([processingId, list]) => {
			const sealed = list.filter((a) => a.finishedAt !== null);
			const startedAt = Math.min(...list.map((a) => a.enqueuedAt));
			const endedAt = sealed.length ? Math.max(...sealed.map((a) => a.finishedAt!)) : null;
			return {
				processingId,
				startedAt,
				endedAt,
				// Null while anything is still in flight, rather than measured against `now` — a duration
				// that shrinks as you watch it is worse than no duration.
				totalMs: endedAt !== null && sealed.length === list.length ? endedAt - startedAt : null,
				outcome: processOutcome(list),
				attempts: list.map(toAudit)
			};
		})
		.sort((a, b) => a.startedAt - b.startedAt);
}

/** Why the song has no lyrics, from its LATEST finished align attempt: an older note is stale once a later align ran. */
export function latestLyricsNote(attempts: JobAttempt[]): string | null {
	const aligns = attempts.filter((a) => a.jobType === 'align' && a.finishedAt !== null);
	const last = aligns.reduce<JobAttempt | null>((acc, a) => (!acc || a.finishedAt! >= acc.finishedAt! ? a : acc), null);
	return last?.lyricsNote ?? null;
}

/** One word for how a process went, chosen so a partial failure never reads as success. */
function processOutcome(list: JobAttempt[]): 'running' | 'ready' | 'failed' | 'canceled' {
	if (list.some((a) => a.outcome === null)) return 'running';
	if (list.some((a) => a.outcome === 'failed')) return 'failed';
	if (list.some((a) => a.outcome === 'canceled')) return 'canceled';
	return 'ready';
}

export function toAudit(a: JobAttempt): AuditAttempt {
	return {
		id: a.id,
		jobType: a.jobType,
		attempt: a.attempt,
		outcome: a.outcome,
		error: a.error,
		workerId: a.workerId,
		enqueuedAt: a.enqueuedAt,
		startedAt: a.startedAt,
		finishedAt: a.finishedAt,
		queueWaitMs: queueWaitMs(a),
		processingMs: processingMs(a),
		rtFactor: realtimeFactor(a),
		models: {
			engine: a.engine,
			model: a.model,
			backend: a.backend,
			device: a.device,
			// A string like its siblings, because the page prints this bag as label/value text.
			threads: a.threads == null ? null : String(a.threads),
			concurrency: a.concurrency == null ? null : String(a.concurrency),
			demucsJobs: a.demucsJobs == null ? null : String(a.demucsJobs),
			asrModel: a.asrModel,
			syncMode: a.syncMode
		},
		handSet: attemptHandSet(a),
		stages: attemptStages(a),
		selection: attemptSelection(a)
	};
}
