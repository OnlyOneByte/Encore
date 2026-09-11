// The shape of the audit response, extracted from +server.ts so it can be exported and unit-tested:
// a SvelteKit +server.ts may only export HTTP method handlers, so the mapper and its interface live
// here (imported by the route). No behaviour lives in the route beyond fetching and shaping.
import { attemptStages, attemptSelection, realtimeFactor, type JobAttempt, type SelectionRecord } from '@encore/shared';
import { processingMs, queueWaitMs } from '$server/jobs/metrics';

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
		asrModel: string | null;
		syncMode: string | null;
	};
	stages: { stage: string; ms: number }[];
	// WHY this lyric won, when the attempt recorded it. Null on every non-align attempt.
	selection: SelectionRecord | null;
}

export function groupCooks(attempts: JobAttempt[]) {
	const byCook = new Map<string, JobAttempt[]>();
	for (const a of attempts) {
		const key = a.cookId || '(pre-ledger)';
		const list = byCook.get(key) ?? [];
		list.push(a);
		byCook.set(key, list);
	}
	return [...byCook.entries()]
		.map(([cookId, list]) => {
			const sealed = list.filter((a) => a.finishedAt !== null);
			const startedAt = Math.min(...list.map((a) => a.enqueuedAt));
			const endedAt = sealed.length ? Math.max(...sealed.map((a) => a.finishedAt!)) : null;
			return {
				cookId,
				startedAt,
				endedAt,
				// Null while anything is still in flight, rather than measured against `now` — a duration
				// that shrinks as you watch it is worse than no duration.
				totalMs: endedAt !== null && sealed.length === list.length ? endedAt - startedAt : null,
				outcome: cookOutcome(list),
				attempts: list.map(toAudit)
			};
		})
		.sort((a, b) => a.startedAt - b.startedAt);
}

/** One word for how a cook went, chosen so a partial failure never reads as success. */
export function cookOutcome(list: JobAttempt[]): 'running' | 'ready' | 'failed' | 'canceled' {
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
			asrModel: a.asrModel,
			syncMode: a.syncMode
		},
		stages: attemptStages(a),
		selection: attemptSelection(a)
	};
}
