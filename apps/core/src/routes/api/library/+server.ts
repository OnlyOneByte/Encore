// GET /api/library — the durable catalog's two interesting states, for a client that has just
// loaded and has received no broadcasts yet:
//
//   library — songs whose stems are already separated on disk. Re-queueing one skips the worker
//             entirely (no 1–2 min cook), which is the whole point of persisting the catalog.
//   cooking — songs being separated RIGHT NOW, with their live progress. Without this, reloading
//             the phone mid-cook lost the progress bar until the next broadcast happened to fire.
//
// Read-only and unauthenticated, like /api/search — queueing still requires a joined singer.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { hydrateMediaCatalog } from '$server/media/repository';
import { readinessOf } from '$server/media/readiness';
import { mediaStatusFor } from '$server/jobs/media-status';
import type { MediaStatus } from '@encore/shared';

export const GET: RequestHandler = async () => {
	const app = getApp();
	const library = app.media.listReady();
	// The hub validates adds against the runtime catalog, so anything we offer for one-tap re-queue
	// must be resolvable there. Boot hydration already covers this; re-seeding keeps the endpoint
	// honest if a row was written by another path.
	hydrateMediaCatalog(library, app.mediaById);

	// Cooking state is runtime, not durable — read it from the live catalog + job ledger.
	const cooking = [...app.mediaById.values()]
		.filter((m) => readinessOf(m) === 'cooking')
		.map((media) => {
			const job = app.jobs.findLive(media.id, 'stems');
			return {
				media,
				status: job ? mediaStatusFor(job, (job.stage as MediaStatus) ?? undefined) : ('queued' as MediaStatus),
				pct: job?.progressPct ?? 0,
				etaSec: job?.etaSec ?? undefined
			};
		});

	return json({ library, cooking });
};
