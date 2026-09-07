// GET /api/library — the durable catalog's two interesting states for a just-loaded client that
// has received no broadcasts yet:
//   library — stems already on disk. Re-queueing skips the worker (no 1–2 min cook), the whole
//             point of persisting the catalog.
//   cooking — songs separating RIGHT NOW, with live progress. Without this, reloading the phone
//             mid-cook lost the progress bar until the next broadcast fired.
// Read-only and unauthenticated, like /api/search — queueing still requires a joined singer.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { hydrateMediaCatalog } from '$server/media/repository';
import { readinessOf } from '$server/media/readiness';
import { mediaStatusFor } from '$server/jobs/media-status';
import type { MediaStatus } from '@encore/shared';

export const GET: RequestHandler = async ({ url }) => {
	const app = getApp();

	// Browse: an optional facet filter. Only READY songs are browsable — the catalog holds
	// every search result ever materialised (271 rows for 7 cooked songs on the live box), so browsing
	// the whole table would bury the library in things you cannot sing yet.
	const artist = url.searchParams.get('artist')?.trim();
	const library = artist ? app.media.byArtist(artist) : app.media.listReady();

	// The hub validates adds against the runtime catalog, so anything we offer for one-tap re-queue
	// must be resolvable there. Boot hydration already covers this; re-seeding keeps the endpoint
	// honest if a row was written by another path.
	hydrateMediaCatalog(library, app.mediaById);

	// Cooking state is runtime, not durable — read it from the live catalog + job ledger.
	const cooking = [...app.mediaById.values()]
		.filter((m) => readinessOf(m) === 'cooking')
		.map((media) => {
			// The OUTSTANDING step, whatever its type. This asked for a live `stems` job and nothing else,
			// so a song mid-fetch or mid-align matched none and fell through to the hardcoded 'queued'
			// below — a phone reloading during either step watched the progress strip jump backwards, the
			// same defect the broadcasts had (see jobs/media-status.ts).
			const job = app.jobs.findOutstandingForMedia(media.id);
			return {
				media,
				status: job ? mediaStatusFor(job, (job.stage as MediaStatus) ?? undefined) : ('queued' as MediaStatus),
				pct: job?.progressPct ?? 0,
				etaSec: job?.etaSec ?? undefined
			};
		});

	return json({
		library,
		cooking,
		// Browse facets always describe the WHOLE ready library, never the current filter — otherwise
		// picking an artist would collapse the facet list to that one artist and strand you there.
		facets: { artists: app.media.artistFacets() },
		filter: artist ? { artist } : null
	});
};
