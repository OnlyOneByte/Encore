// GET /api/search?q=... — ONE search across every source, partitioned by readiness.
//
// Rejected the old source switch (?source=youtube|local, caller picks an index): a singer picks by
// whether they can sing a song now with no vocals, not by where it came from. So this searches every
// resolver, materializes + persists each hit, and returns three groups — ready (stems on disk),
// cooking (stems in flight), raw (plays with vocals) — each song appearing exactly once. `source`
// survives as an optional narrowing filter.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { resultToMedia, type MediaResolver, type SearchResult } from '$server/media/resolver';
import { partitionSearch } from '$server/media/readiness';
import { ulid, type Media } from '@encore/shared';

const PER_SOURCE_LIMIT = 12;

/** One resolver's results, or none — a dead source (yt-dlp missing, no network) must not fail the
 *  whole search, because the local library and the already-cooked catalog are still useful. */
async function safeSearch(resolver: MediaResolver | undefined, q: string): Promise<SearchResult[]> {
	if (!resolver) return [];
	try {
		return await resolver.search(q, PER_SOURCE_LIMIT);
	} catch {
		return [];
	}
}

export const GET: RequestHandler = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim();
	const only = url.searchParams.get('source'); // optional narrowing: 'youtube' | 'local'
	const app = getApp();

	// Empty query returns recent + popular from this session. The readiness groups still come back
	// (empty) so the client renders one shape in both states.
	if (!q) {
		const byId = (id: string) => app.mediaById.get(id);
		const recent = app.popularity.recent(6).map(byId).filter(Boolean);
		const popular = app.popularity.popular(6).map(byId).filter(Boolean);
		return json({ ready: [], cooking: [], results: [], recent, popular });
	}

	const [yt, local] = await Promise.all([
		only === 'local' ? [] : safeSearch(app.youtube, q),
		only === 'youtube' ? [] : safeSearch(app.localLibrary, q)
	]);

	// Materialize every hit into a queue-able Media. Recognising a song we have SEEN BEFORE (by its
	// origin identity) is what keeps a cooked song from reappearing as a second, raw row — see
	// Media.sourceRef, which is immutable for exactly this reason.
	const materialized: Media[] = [...local, ...yt].map((r) => {
		const existing = [...app.mediaById.values()].find(
			(m) => m.source === r.source && m.sourceRef === r.sourceRef
		);
		if (existing) return existing;
		const media = resultToMedia(ulid(), r);
		app.mediaById.set(media.id, media);
		// Persist on materialize so the id stays valid across a restart — a queue entry (or a
		// cooked stem) referencing this media must still resolve to a title after the server bounces.
		app.media.upsert(media);
		return media;
	});

	const { ready, cooking, unacquired } = partitionSearch(q, [...app.mediaById.values()], materialized);
	// `results` keeps its name for the unacquired group: it is what still needs work to become karaoke.
	return json({ ready, cooking, results: unacquired });
};
