// GET /api/search?q=... — ONE search across every source, partitioned by readiness.
//
// Rejected the old source switch (?source=youtube|local, caller picks an index): a singer picks by
// whether they can sing a song now with no vocals, not by where it came from. So this searches every
// resolver, materializes + persists each hit, and returns three groups — ready (stems on disk),
// processing (stems in flight), raw (plays with vocals) — each song appearing exactly once. `source`
// survives as an optional narrowing filter.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { resultToMedia, type MediaResolver, type SearchResult } from '$lib/server/media/resolver';
import { partitionSearch } from '$lib/server/media/readiness';
import { ulid, type Media } from '$lib/contract';

const PER_SOURCE_LIMIT = 12;

/** One resolver's results, or none — a dead source (yt-dlp missing, no network) must not fail the
 *  whole search, because the local library and the already-processed catalog are still useful. */
async function safeSearch(resolver: MediaResolver | undefined, q: string): Promise<SearchResult[]> {
	if (!resolver) return [];
	try {
		return await resolver.search(q, PER_SOURCE_LIMIT);
	} catch {
		return [];
	}
}

/**
 * Refresh the DISPLAY-ONLY fields on a song we already know, from a fresh resolver hit.
 *
 * Mutates in place on purpose: `mediaById` hands out live object references (rotation, the hub and the
 * worker dispatch all hold them), so replacing the object would leave those readers on a stale copy.
 *
 * Strictly limited to `viewCount` and `thumbnail`. Everything else — title, artist, the canonicals,
 * stemStatus, every artifact ref — is either immutable identity or hard-won process state, and a search
 * result is not evidence about any of it. In particular this must never touch `stemStatus`, or
 * searching for a song you already processed would un-process it.
 *
 * `thumbnail` is included because it is now DERIVED from the video id (see ytThumbnailUrl), so
 * refreshing replaces the signed, inconsistently-sized URLs stored by earlier versions with the stable
 * 16:9 one — no re-process, no migration, just the next time the song appears in a search.
 */
function refreshDisplayFields(existing: Media, r: SearchResult, persist: (m: Media) => void): Media {
	let changed = false;
	if (r.viewCount !== undefined && r.viewCount !== existing.viewCount) {
		existing.viewCount = r.viewCount;
		changed = true;
	}
	if (r.thumbnail && r.thumbnail !== existing.thumbnail) {
		existing.thumbnail = r.thumbnail;
		changed = true;
	}
	// Only write when something actually moved: a search is up to 12 hits and runs on a debounced
	// keystroke, so an unconditional upsert would be a needless write per row per search.
	if (changed) persist(existing);
	return existing;
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
		return json({ ready: [], processing: [], results: [], recent, popular });
	}

	const [yt, local, spotify] = await Promise.all([
		only === 'local' || only === 'spotify' ? [] : safeSearch(app.youtube, q),
		only === 'youtube' || only === 'spotify' ? [] : safeSearch(app.localLibrary, q),
		// Spotify is a SEARCH / metadata source only (annotator pattern): its hits surface clean
		// canonical artist/title/duration and appear in the merged output, but their bytes are never
		// pulled from Spotify — a spotify-sourced media is not processable (`isProcessableSource`, the one
		// authority; asked by `processState`, by the phone's `canProcess`, and by this route's consumers).
		// No-op when creds are unset; safeSearch tolerates a dead source.
		only === 'youtube' || only === 'local' ? [] : safeSearch(app.spotify, q)
	]);

	// Materialize every hit into a queue-able Media. Recognising a song we have SEEN BEFORE (by its
	// origin identity) is what keeps a processed song from reappearing as a second, raw row — see
	// Media.sourceRef, which is immutable for exactly this reason.
	const materialized: Media[] = [...local, ...yt, ...spotify].map((r) => {
		const existing = [...app.mediaById.values()].find((m) => m.source === r.source && m.sourceRef === r.sourceRef);
		if (existing) return refreshDisplayFields(existing, r, (m) => app.media.upsert(m));
		const media = resultToMedia(ulid(), r);
		app.mediaById.set(media.id, media);
		// Persist on materialize so the id stays valid across a restart — a queue entry (or a
		// processed stem) referencing this media must still resolve to a title after the server bounces.
		app.media.upsert(media);
		return media;
	});

	const { ready, processing, unacquired } = partitionSearch(q, [...app.mediaById.values()], materialized);
	// `results` keeps its name for the unacquired group: it is what still needs work to become karaoke.
	return json({ ready, processing, results: unacquired });
};
