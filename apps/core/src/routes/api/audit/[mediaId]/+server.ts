// GET /api/audit/[mediaId] — everything this system knows about how ONE song came to be.
//
// This is the endpoint the whole feature was asked for: click a song, read its audit log. Every cook
// it went through, every attempt including the ones that failed, which model ran each step, how long
// each took, and every time it has been sung.
//
// Ungated for the same reason as /api/metrics, and it exposes the same class of internal detail
// (worker ids, model names, error strings) for one song rather than in aggregate.
import type { RequestHandler } from '@sveltejs/kit';
import { error, json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { attemptStages, realtimeFactor, type JobAttempt } from '@encore/shared';
import { processingMs, queueWaitMs } from '$server/jobs/metrics';

export const GET: RequestHandler = async ({ params }) => {
	const app = getApp();
	const mediaId = params.mediaId;
	if (!mediaId) error(400, 'mediaId required');

	const attempts = app.attempts.byMedia(mediaId);
	const media = app.mediaById.get(mediaId) ?? app.media.byId(mediaId) ?? null;
	// A song with no media row AND no attempt history is genuinely unknown — 404 rather than an empty
	// shell, so a typo in the id is distinguishable from a song that simply predates the ledger.
	if (!media && attempts.length === 0) error(404, 'unknown song');

	return json({
		media,
		// Grouped into COOKS, because that is the unit a reader thinks in: "the first time we made this,
		// and then the upgrade". A flat list of attempts on one media id blurs those together.
		cooks: groupCooks(attempts),
		plays: app.playLog.forMedia(mediaId),
		// Whether history is complete for this song. Attempts predate nothing else in the system, so a
		// song cooked before the ledger existed shows an empty timeline; saying so is better than
		// letting it read as "this song was never processed".
		hasHistory: attempts.length > 0
	});
};

interface AuditAttempt {
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
	models: { engine: string | null; model: string | null; backend: string | null; device: string | null; asrModel: string | null; syncMode: string | null };
	stages: { stage: string; ms: number }[];
}

function groupCooks(attempts: JobAttempt[]) {
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
function cookOutcome(list: JobAttempt[]): 'running' | 'ready' | 'failed' | 'canceled' {
	if (list.some((a) => a.outcome === null)) return 'running';
	if (list.some((a) => a.outcome === 'failed')) return 'failed';
	if (list.some((a) => a.outcome === 'canceled')) return 'canceled';
	return 'ready';
}

function toAudit(a: JobAttempt): AuditAttempt {
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
		stages: attemptStages(a)
	};
}
