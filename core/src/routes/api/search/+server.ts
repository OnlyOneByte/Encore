// GET /api/search?q=... — ONE search across every source, partitioned by readiness. Rejected the old source switch (?source=youtube|local, caller picks an index): a singer picks by whether they can sing a song now with no vocals, not by where it came from. So this searches every resolver, materializes + persists each hit, and returns three groups — ready (stems on disk), processing (stems in flight), raw (plays with vocals) — each song appearing exactly once. `source` survives as an optional narrowing filter.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { resultToMedia, type MediaResolver, type SearchResult } from '$lib/server/media/resolver';
import { partitionSearch } from '$lib/server/media/readiness';
import { ulid, type Media } from '$lib/contract';

const PER_SOURCE_LIMIT = 12;

/**
 * What a search with no `?source=` asks. NOTE WHAT IS ABSENT: plain all-of-YouTube `ytsearch`.
 *
 * WHAT IS GAINED, measured: the real performer instead of a channel name ("The Black Eyed Peas", not
 * "Tasty"), the track duration instead of a video length, and a median 459 ms against 1628 ms — ytsearch
 * spawns a yt-dlp subprocess, and on one probe it was killed at its 10 s timeout and returned nothing
 * at all where ytmusic answered.
 *
 * WHAT IS LOST, equally measured, because the first version of this comment overstated the case. An
 * earlier sweep of 18 hard queries "returned a usable hit for every one" — but that sweep had NO
 * NEGATIVE CONTROL, and the `songs` filter NEVER RETURNS EMPTY: `zzzzzzznotasongzzzzzz` answers with
 * "A Million Laughing Emoji's", and `asdkjhqwe zxcvbnm nonsense query 12345` answers with Mariah Carey.
 * So that sweep measured "did rows come back", not "did the right song come back". Against a specific
 * upload the catalog substitutes a catalog entity: `bohemian rhapsody live aid 1985 full` leads with a
 * 148 s studio-soundtrack cut, where ytsearch finds the actual performance.
 *
 * THAT IS WHY THE WIDEN AFFORDANCE IS NOT GATED ON AN EMPTY RESULT (see `+page.svelte`): a narrow
 * default whose escape hatch only appears when nothing matched has no escape hatch at all, since
 * nothing matching is a state this default cannot reach.
 *
 * `local` and `spotify` STAY IN THE DEFAULT, and that is the reason this is a set rather than simply
 * defaulting the param to `ytmusic`: local files are the user's OWN media, they live in a separate
 * disk-scan FTS index rather than the catalog, and the catalog's own matcher is strictly weaker (a
 * contiguous substring against title OR artist, so "backstreet boys i want it that way" matches a
 * `Artist - Title` drop-in file under neither field). Narrowing to one source would hide them.
 *
 * `?source=all` is the escape hatch that adds `ytsearch` back, for the upload no catalog lists.
 */
const DEFAULT_SOURCES = new Set(['ytmusic', 'local', 'spotify']);

/** A song's ORIGIN identity — the pair `Media.sourceRef` is immutable for. NUL-joined, since neither half can contain one. */
const originKey = (source: string, sourceRef: string): string => `${source}\u0000${sourceRef}`;

/** One resolver's results, or none — a dead source (yt-dlp missing, no network) must not fail the whole search, because the local library and the already-processed catalog are still useful. */
async function safeSearch(resolver: MediaResolver | undefined, q: string): Promise<SearchResult[]> {
	if (!resolver) return [];
	try {
		return await resolver.search(q, PER_SOURCE_LIMIT);
	} catch {
		return [];
	}
}

/** Refresh the DISPLAY-ONLY fields (`viewCount`, `thumbnail`) on a song we already know, from a fresh resolver hit. Mutates in place on purpose: `mediaById` hands out live object references (rotation, the hub, worker dispatch all hold them), so replacing the object would leave those readers on a stale copy. Everything else — title, artist, canonicals, stemStatus, artifact refs — is either immutable identity or hard-won process state that a search result is not evidence about; in particular this must NEVER touch `stemStatus`, or searching for an already-processed song would un-process it. `thumbnail` is included because it's now DERIVED from the video id (ytThumbnailUrl), so refreshing swaps in the stable 16:9 URL for whatever earlier versions stored, with no migration. */
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
	// Only write when something actually moved — a search is up to 12 hits on a debounced keystroke, so an unconditional upsert would be a needless write per row per search.
	if (changed) persist(existing);
	return existing;
}

export const GET: RequestHandler = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim();
	const only = url.searchParams.get('source'); // 'youtube' | 'ytmusic' | 'local' | 'spotify' | 'all'
	const wants = (source: string) => (only ? only === 'all' || only === source : DEFAULT_SOURCES.has(source));
	const app = getApp();

	// Empty query returns recent + popular from this session; the readiness groups still come back empty, so the client renders one shape in both states.
	if (!q) {
		// A song waiting out its delete Undo window is not offered here either.
		const byId = (id: string) => (app.pendingDeletes.has(id) ? undefined : app.mediaById.get(id));
		const recent = app.popularity.recent(6).map(byId).filter(Boolean);
		const popular = app.popularity.popular(6).map(byId).filter(Boolean);
		return json({ ready: [], processing: [], results: [], recent, popular });
	}

	const [yt, ytm, local, spotify] = await Promise.all([
		wants('youtube') ? safeSearch(app.youtube, q) : [],
		// YouTube MUSIC: the catalog's song entities (real artist, album, duration) instead of whatever
		// uploads matched. Same `source: 'youtube'` identity — where a hit was FOUND is not what it IS —
		// so a song discovered here dedupes against the same video found by ytsearch, and every consumer
		// (fetcher, thumbs, retention) already speaks it.
		wants('ytmusic') ? safeSearch(app.ytmusic, q) : [],
		wants('local') ? safeSearch(app.localLibrary, q) : [],
		// Spotify is a SEARCH/metadata source only (annotator pattern): its hits carry clean canonical artist/title/duration into the merged output, but a spotify-sourced media is never processable — `isProcessableSource` is the one authority on that, asked by `processState`, the phone's `canProcess`, and this route's consumers. No-op when creds are unset; safeSearch tolerates a dead source.
		wants('spotify') ? safeSearch(app.spotify, q) : []
	]);

	// ONE index over the catalog, not a full scan per hit: this runs on a debounced keystroke against every song ever materialised. Earliest-inserted wins per origin, and newly minted rows are fed back in, so two resolvers returning the same video still collapse to one Media.
	const byOrigin = new Map<string, Media>();
	for (const m of app.mediaById.values()) {
		const key = originKey(m.source, m.sourceRef);
		if (!byOrigin.has(key)) byOrigin.set(key, m);
	}

	// Materialize every hit into a queue-able Media. Recognising a song already SEEN (by its origin identity) is what keeps a processed song from reappearing as a second, raw row — see Media.sourceRef, immutable for exactly this reason.
	// Music-catalog hits first among the new: their artist/title are the catalog's own, so when both
	// searches return the same video the minted row carries the better metadata.
	const materialized: Media[] = [...local, ...ytm, ...yt, ...spotify].map((r) => {
		const key = originKey(r.source, r.sourceRef);
		const existing = byOrigin.get(key);
		if (existing) return refreshDisplayFields(existing, r, (m) => app.media.upsert(m));
		const media = resultToMedia(ulid(), r);
		app.mediaById.set(media.id, media);
		byOrigin.set(key, media);
		// Persist on materialize so the id stays valid across a restart — a queue entry or processed stem referencing this media must still resolve to a title after the server bounces.
		app.media.upsert(media);
		return media;
	});

	// A song the host just deleted is offered nowhere while its Undo window runs.
	const offered = (m: Media) => !app.pendingDeletes.has(m.id);
	const { ready, processing, unacquired, clipped } = partitionSearch(
		q,
		[...app.mediaById.values()].filter(offered),
		materialized.filter(offered)
	);
	/* `results` keeps its name for the unacquired group: it is what still needs work to become karaoke.
	   `clipped` is REPORTED rather than acted on here: the phone already reveals in pages and can say "there
	   are more" honestly, and a route that silently truncated would be the same class of lie as the zero-state
	   that used to claim a failed search found nothing. */
	return json({ ready, processing, results: unacquired, clipped });
};
