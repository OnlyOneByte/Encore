// GET /api/audit/[mediaId] — everything this system knows about how ONE song came to be: every
// process, every attempt (including failures), which model ran each step, how long, and every time
// it's been sung. Ungated, same as /api/metrics — see docs/ARCHITECTURE.md §10. The response SHAPE
// (AuditAttempt, toAudit, groupProcesses) lives in ./audit-shape so it's unit-testable — a +server.ts
// may only export HTTP method handlers.
import type { RequestHandler } from '@sveltejs/kit';
import { error, json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { groupProcesses } from './audit-shape';

export const GET: RequestHandler = async ({ params }) => {
	const app = getApp();
	const mediaId = params.mediaId;
	if (!mediaId) error(400, 'mediaId required');

	const attempts = app.attempts.byMedia(mediaId);
	const media = app.mediaById.get(mediaId) ?? app.media.byId(mediaId) ?? null;
	// A song with no media row AND no attempt history is genuinely unknown — 404 rather than an empty shell, so a typo in the id is distinguishable from a song that simply predates the ledger.
	if (!media && attempts.length === 0) error(404, 'unknown song');

	return json({
		media,
		processes: groupProcesses(attempts), // grouped into PROCESSES, the unit a reader thinks in ("the first time, then the upgrade") — a flat attempt list blurs those together
		plays: app.playLog.forMedia(mediaId),
		// Whether history is complete: attempts predate nothing else, so a song processed before the
		// ledger existed shows an empty timeline — saying so beats it reading as "never processed".
		hasHistory: attempts.length > 0
	});
};
