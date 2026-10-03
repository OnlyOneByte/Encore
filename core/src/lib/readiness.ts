// Client-side readiness view state. The CLASSIFICATION is shared with the server through
// `$lib/contract/process/readiness` and must stay there: two copies with a parity test is one function with two
// homes. Client-only here: a LIVE media:status can override the catalog, and 'failed' exists only as a live event.
import { isProcessableSource, readyToSing, type Media, type MediaStatus } from '$lib/contract';
import { readinessOf, type CatalogReadiness } from '$lib/contract/process/readiness';

export { readinessOf };

/** Catalog readiness plus `failed`, which only a live `media:status` event can produce. */
export type Readiness = CatalogReadiness | 'failed';

/** Readiness for display, letting a LIVE status override the catalog: the event arrives before the catalog copy is
 * refreshed, so a song the singer just tapped must read as processing immediately. A `failed` status is SURFACED,
 * never swallowed — but only when the song is not actually singable, so a failed lyrics upgrade does not surface. */
export function displayReadiness(m: Media, live?: { status: MediaStatus }): Readiness {
	if (live) {
		if (live.status === 'ready') return 'ready';
		if (live.status === 'failed') return readyToSing(m) ? 'ready' : 'failed';
		// A cancel is terminal but NOT a failure, so the catalog answers: the media is already back to
		// un-processed, and reporting 'failed' would tell a guest who removed a song that the process broke.
		if (live.status === 'canceled') return readinessOf(m);
		return 'processing';
	}
	return readinessOf(m);
}

/** Which card an entry in the ROTATION gets. A terminally failed process is NOT in flight, so an "is it in flight"
 * test renders a dead turn as an ordinary waiting one while the rotation holds its slot and skips it every pass.
 * Failure is decided by `displayReadiness`, NEVER by a fresh `status === 'failed'` test, so this cannot disagree. */
export type QueueCardKind = 'processing' | 'failed' | 'plain';

export function queueCardKind(media: Media | undefined, live?: { status: MediaStatus }): QueueCardKind {
	if (!live) return 'plain';
	if (live.status === 'ready' || live.status === 'canceled') return 'plain';
	// A media missing from the catalog cannot be asked whether it is singable, so the live status is
	// the only witness — take it at its word rather than silently downgrading a dead process to plain.
	if (live.status === 'failed') return media && displayReadiness(media, live) !== 'failed' ? 'plain' : 'failed';
	return 'processing';
}

/** Whether offering "make karaoke" makes sense: only for a song neither done nor in flight, AND whose audio can
 * actually be acquired. A FAILED song qualifies. IT MUST TAKE THE MEDIA, not just its readiness: a metadata-only hit
 * that can never be processed reads as un-acquired exactly like a fresh upload, and offering Sing there takes the
 * singer's turn and leaves a turn nothing can ever make ready. `isProcessableSource` is the shared authority. */
export function canProcess(m: Media, r: Readiness): boolean {
	return isProcessableSource(m.source) && (r === 'unacquired' || r === 'failed');
}

/** What the screen says when NO rows are showing at all — the one zero-state for both views.
 *
 * It answered only for the "Ready" filter once, and the rename is the fix for a real bug: gated on the ready
 * group alone, its copy printed "Nothing matches “…”" underneath twelve unprocessed search results, which
 * contradicted the rows on screen. Nothing-READY is the normal case for a song nobody has processed yet;
 * nothing-FOUND is the only state that warrants a sentence. */
export interface NoRowsState {
	message: string;
	/** When set, the UI offers a one-tap way back to the library (clears the search).
	 *
	 * A PRESENCE SIGNAL, and no longer a label. The control it gates clears the search, which reveals the
	 * home column's SHELF, itself capped (at four rows on a phone, eight at --bp-lg) — so a label reading
	 * "Show all 13" promised rows that tap does not
	 * produce. The number stays here because "is there anything to go back to" is exactly what the caller
	 * needs, and callers that want the real library size read it from the same place /library does. */
	showAllCount: number | null;
}

/** Whether the screen is showing NO rows, and may therefore say so.
 *
 * A PREDICATE RATHER THAN A TEMPLATE CONDITION, because the bug this fixes was unreachable by any test:
 * the gate lived inline in `+page.svelte` as `!readyResults.length && library.length`, which is true
 * whenever nothing is karaoke-READY — so a query returning twelve unprocessed songs printed "Nothing
 * matches" beneath them. Every group has to be empty, and "every" is exactly the sort of thing that
 * silently loses a term when a fourth group is added later.
 *
 * `searching` is a term for the same reason: mid-flight, the state still holds the PREVIOUS query's
 * groups, so a zero-state rendered then is a claim about a search that has not finished. */
export function showsNoRows(opts: {
	searching: boolean;
	readyCount: number;
	rawCount: number;
	processingCount: number;
}): boolean {
	if (opts.searching) return false;
	return opts.readyCount === 0 && opts.rawCount === 0 && opts.processingCount === 0;
}

export function noRowsState(opts: { searchActive: boolean; libraryCount: number; query?: string }): NoRowsState {
	const { searchActive, libraryCount } = opts;
	// SEARCH IS TESTED FIRST, and the order is the whole correctness of this function. A search that found
	// nothing is a statement about THE QUERY; "no karaoke-ready songs yet" is a statement about the
	// LIBRARY. Testing the library first said the second thing whenever the library happened to be empty,
	// so a failed search on a fresh install blamed the library for a query that simply missed.
	if (searchActive) {
		const q = (opts.query ?? '').trim();
		return {
			message: q ? `Nothing matches “${q}”.` : 'Nothing matches this search.',
			// Only promise the way back when there is something to go back TO.
			showAllCount: libraryCount > 0 ? libraryCount : null
		};
	}
	// A genuinely empty library — this copy is correct here, and only here.
	if (libraryCount === 0) {
		return {
			// No control name and no mark: a plain string cannot hold one, and naming a button is how copy comes to point
			// at a control that has been relabelled.
			message: 'No karaoke-ready songs yet.',
			showAllCount: null
		};
	}
	// Not searching with a non-empty library means the group should have rendered rows, so this is unreachable
	// in practice — it returns something honest rather than the false "none yet".
	return { message: `${libraryCount} karaoke ${libraryCount === 1 ? 'song' : 'songs'} ready.`, showAllCount: null };
}

/** Client mirror of the server's own playability check, and the two MUST agree or the phone narrates a different
 * rotation than the TV performs. */
export function entryPlayable(media: Media | undefined, live?: { status: MediaStatus }): boolean {
	// A live status decides in BOTH directions: `ready` means the process landed before the catalog caught up.
	// `failed` and `canceled` are terminal and say nothing about playability, so the catalog answers for both.
	if (live && live.status === 'ready') return true;
	if (live && live.status !== 'failed' && live.status !== 'canceled') return false; // still processing
	if (!media) return false;
	return readyToSing(media);
}

/** The first PLAYABLE queued entry, never the first in the list: the server skips an entry whose stems are still
 * processing, so "first" promises a song the TV is about to skip past. `entries` must be in rotation order. */
export function nextPlayableEntryId<E extends { id: string; mediaId: string }>(
	entries: E[],
	mediaOf: (mediaId: string) => Media | undefined,
	liveOf: (mediaId: string) => { status: MediaStatus } | undefined
): string | null {
	return entries.find((e) => entryPlayable(mediaOf(e.mediaId), liveOf(e.mediaId)))?.id ?? null;
}

/** The media ids that belong in the "Processing" group, as an ORDER-INDEPENDENT set. THE QUERY IS A LOAD-BEARING
 * INPUT: with a search active this restricts to the server's query-matched group, because re-deriving from the whole
 * status map lets someone else's processing song appear under an unrelated search. With no search it is the full
 * union, which guarantees a process you started is visible; `failed` is included, `ready` and `canceled` are not. */
export function processingGroupIds(opts: {
	searchActive: boolean;
	processingResults: Media[];
	mediaStatus: ReadonlyMap<string, { status: MediaStatus }>;
	mediaCatalog: ReadonlyMap<string, Media>;
	readiness: (m: Media) => Readiness;
}): Set<string> {
	const { searchActive, processingResults, mediaStatus, mediaCatalog, readiness } = opts;
	if (searchActive) {
		// The server already scoped this to the query. Trust the wire; do NOT re-scan the catalog.
		return new Set(processingResults.map((m) => m.id));
	}
	const ids = new Set<string>();
	for (const [id, s] of mediaStatus) if (s.status !== 'ready' && s.status !== 'canceled') ids.add(id);
	for (const [id, m] of mediaCatalog) if (readiness(m) === 'processing') ids.add(id);
	return ids;
}
