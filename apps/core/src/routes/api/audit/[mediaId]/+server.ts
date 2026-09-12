// GET /api/audit/[mediaId] — everything this system knows about how ONE song came to be.
//
// This is the endpoint the whole feature was asked for: click a song, read its audit log. Every cook
// it went through, every attempt including the ones that failed, which model ran each step, how long
// each took, and every time it has been sung.
//
// Ungated for the same reason as /api/metrics, and it exposes the same class of internal detail
// (worker ids, model names, error strings) for one song rather than in aggregate.
//
// The response SHAPE (AuditAttempt, toAudit, groupCooks) lives in ./audit-shape so it can be exported
// and unit-tested — a SvelteKit +server.ts may only export HTTP method handlers.
import type { RequestHandler } from '@sveltejs/kit';
import { error, json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { groupCooks } from './audit-shape';

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
