// GET /api/library — the durable catalog's two interesting states for a just-loaded client that
// has received no broadcasts yet:
//   library — stems already on disk. Re-queueing skips the worker (no 1–2 min process), the whole
//             point of persisting the catalog.
//   processing — songs separating RIGHT NOW, with live progress. Without this, reloading the phone
//             mid-process lost the progress bar until the next broadcast fired.
// Read-only and unauthenticated, like /api/search — queueing still requires a joined singer.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { hydrateMediaCatalog } from '$lib/server/media/repository';
import { readinessOf } from '$lib/server/media/readiness';
import { mediaStatusFor } from '$lib/server/jobs/media-status';
import type { MediaStatus } from '$lib/contract';

export const GET: RequestHandler = async ({ url }) => {
	const app = getApp();

	// Browse: an optional facet filter. Only READY songs are browsable — the catalog holds
	// every search result ever materialised (271 rows for 7 processed songs on the live box), so browsing
	// the whole table would bury the library in things you cannot sing yet.
	// One active browse facet at a time (the phone UI enforces this too): an artist filter, a tag
	// filter, or neither. `?tag=` reuses the media_tags byKindValue index via byTag — NOT a client-side
	// filter over the whole payload, which the an earlier change design rejected because it wastes an on-disk index
	// and stops scaling past a few hundred songs. artist wins if both are somehow present, matching the
	// mutual-exclusion the chip row already imposes.
	const artist = url.searchParams.get('artist')?.trim();
	const tag = url.searchParams.get('tag')?.trim();
	const library = artist ? app.media.byArtist(artist) : tag ? app.media.byTag(tag) : app.media.listReady();

	// The hub validates adds against the runtime catalog, so anything we offer for one-tap re-queue
	// must be resolvable there. Boot hydration already covers this; re-seeding keeps the endpoint
	// honest if a row was written by another path.
	hydrateMediaCatalog(library, app.mediaById);

	// A song's descriptive tags, so the library row can show what a song IS ("acoustic", "80s")
	// without a second round-trip. Kept as a mediaId → string[] map ALONGSIDE `library` rather than
	// folded into each Media: `Media` is the song's origin identity (search dedupes on it), and tags
	// live in their own table written by a separate path (`setTags(id, 'tag', …)` in app.ts). A map is
	// also the shape an earlier change's tag filter reads — it needs "which songs carry tag X" cheaply, which a
	// per-row array does not give. `tagsOf` defaults to the 'genre' kind, so 'tag' is passed
	// explicitly: that is the kind the sidecar write path populates. Only entries WITH tags are
	// included; a song with none is simply absent from the map (the row omits the chips).
	const tags: Record<string, string[]> = {};
	for (const m of library) {
		const t = app.media.tagsOf(m.id, 'tag');
		if (t.length) tags[m.id] = t;
	}

	// Processing state is runtime, not durable — read it from the live catalog + job ledger.
	const processing = [...app.mediaById.values()]
		.filter((m) => readinessOf(m) === 'processing')
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
		processing,
		// mediaId → its 'tag'-kind values, for the library row's tag chips. Additive: a client
		// that does not read it is unaffected, and an earlier change's tag filter reads this same map.
		tags,
		// Browse facets always describe the WHOLE ready library, never the current filter — otherwise
		// picking an artist would collapse the facet list to that one artist and strand you there. The
		// tag facet rides the same rule and the same byKindValue index the tag filter reads.
		facets: { artists: app.media.artistFacets(), tags: app.media.tagFacets() },
		filter: artist ? { artist } : tag ? { tag } : null
	});
};
