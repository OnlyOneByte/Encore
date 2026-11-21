// GET /api/library — the durable catalog's two interesting states for a just-loaded client that has received no broadcasts yet: `library` (stems already on disk — re-queueing skips the worker, the whole point of persisting the catalog) and `processing` (songs separating RIGHT NOW with live progress, so reloading mid-process doesn't lose the progress bar until the next broadcast). Read-only and unauthenticated, like /api/search — queueing still requires a joined singer.
import type { RequestHandler } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { gzipJson } from '$lib/server/http/gzip-json';
import { hydrateMediaCatalog } from '$lib/server/media/repository';
import { readinessOf } from '$lib/server/media/readiness';
import { mediaStatusFor } from '$lib/server/jobs/media-status';
import type { MediaStatus } from '$lib/contract';

export const GET: RequestHandler = async ({ url, request }) => {
	const app = getApp();

	// Browse: an optional facet filter, one at a time (artist or tag, never both — matching the mutual-exclusion the chip row already imposes; artist wins if both are somehow present). Only READY songs are browsable — the catalog holds every search result ever materialised, far more than what's singable. `?tag=` reuses the media_tags byKindValue index via byTag rather than filtering the whole payload client-side, which doesn't scale past a few hundred songs.
	const artist = url.searchParams.get('artist')?.trim();
	const tag = url.searchParams.get('tag')?.trim();
	const library = artist ? app.media.byArtist(artist) : tag ? app.media.byTag(tag) : app.media.listReady();

	// The hub validates adds against the runtime catalog, so anything offered for one-tap re-queue must be resolvable there; re-seeding keeps this endpoint honest if a row was written by another path.
	hydrateMediaCatalog(library, app.mediaById);

	// A song's descriptive tags, so the library row can show what a song IS ("acoustic", "80s") without a second round-trip. Kept as a mediaId → string[] map alongside `library` rather than folded into each Media: tags live in their own table, written by a separate path (`setTags(id, 'tag', …)` in app.ts), and a map is also what the tag filter needs — "which songs carry tag X" cheaply, which a per-row array doesn't give. `tagsOf` defaults to the 'genre' kind, so 'tag' is passed explicitly — that's the kind the sidecar write path populates. A song with no tags is simply absent from the map.
	const tags: Record<string, string[]> = {};
	for (const m of library) {
		const t = app.media.tagsOf(m.id, 'tag');
		if (t.length) tags[m.id] = t;
	}

	// Processing state is runtime, not durable — read it from the live catalog + job ledger.
	const processing = [...app.mediaById.values()]
		.filter((m) => readinessOf(m) === 'processing')
		.map((media) => {
			// `findOutstandingForMedia` walks ['fetch','stems','align'] and returns the first step that is not `ready`, so a song mid-fetch or mid-align matches its OWN job and `mediaStatusFor` floors the stage at that step — not 'queued'. (This comment used to claim it asked for a live `stems` job alone, i.e. that both those steps fell through to the `'queued'` default below and a phone reloading mid-fetch saw the strip jump backwards. The chain has three types; the fall-through is reached only by a media with no live job at all, which `readinessOf(m) === 'processing'` already excludes except in the torn window `reconcileStrandedGates` repairs at boot.) See jobs/media-status.ts for the broadcast-side twin.
			const job = app.jobs.findOutstandingForMedia(media.id);
			return {
				media,
				status: job ? mediaStatusFor(job, (job.stage as MediaStatus) ?? undefined) : ('queued' as MediaStatus),
				pct: job?.progressPct ?? 0,
				etaSec: job?.etaSec ?? undefined
			};
		});

	// Gzipped: every phone refetches this on connect and on each song turning ready (~800 KB at 500 songs, ~100 KB gzipped).
	return gzipJson(request, {
		library,
		processing,
		tags, // mediaId → its 'tag'-kind values, for the library row's chips; additive, a client that ignores it is unaffected
		// Facets always describe the WHOLE ready library, never the current filter — otherwise picking an artist would collapse the facet list to that one artist and strand you there.
		facets: { artists: app.media.artistFacets(), tags: app.media.tagFacets() },
		filter: artist ? { artist } : tag ? { tag } : null
	});
};
