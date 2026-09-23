// Client-side readiness view state: display overrides, card kinds, empty states, playability.
//
// The CLASSIFICATION is shared with the server through `$lib/contract/process/readiness` and must stay
// there: two copies with a parity test is one function with two homes. What is genuinely client-only is
// that a LIVE media:status can override the catalog, and that 'failed' exists only as a live event — so
// the display union is the catalog union plus that one member.
import { isProcessableSource, readyToSing, type Media, type MediaStatus } from '$lib/contract';
import { readinessOf, type CatalogReadiness } from '$lib/contract/process/readiness';

export { readinessOf };

/** Catalog readiness plus `failed`, which only a live `media:status` event can produce. */
export type Readiness = CatalogReadiness | 'failed';

/**
 * Readiness for display, letting a LIVE status override the catalog: the event arrives before the catalog
 * copy is refreshed, so a song the singer just tapped must read as processing immediately or the row
 * visibly fails to respond to the tap.
 *
 * A `failed` status is SURFACED, never swallowed — falling through to the catalog leaves a dead process
 * still saying it is making karaoke, forever. Only when the song is not actually singable, though: a failed
 * lyrics upgrade on an already-processed song is not a failure the guest needs.
 */
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

/**
 * Which card an entry in the ROTATION gets — the singer's own queue slot, not a search row. A terminally
 * failed process is NOT in flight, so an "is it in flight" test renders a dead turn as an ordinary waiting
 * one while the rotation holds its slot and skips it on every pass.
 *
 * Failure is decided by `displayReadiness`, NEVER by a fresh `status === 'failed'` test, so this cannot
 * disagree with the row and the header that already read it — and it buys the case a raw status test gets
 * wrong: a turn that WILL play must not be labelled broken.
 */
export type QueueCardKind = 'processing' | 'failed' | 'plain';

export function queueCardKind(media: Media | undefined, live?: { status: MediaStatus }): QueueCardKind {
	if (!live) return 'plain';
	if (live.status === 'ready' || live.status === 'canceled') return 'plain';
	// A media missing from the catalog cannot be asked whether it is singable, so the live status is
	// the only witness — take it at its word rather than silently downgrading a dead process to plain.
	if (live.status === 'failed') return media && displayReadiness(media, live) !== 'failed' ? 'plain' : 'failed';
	return 'processing';
}

/**
 * Whether offering "make karaoke" makes sense: only for a song that is neither done nor in flight, AND whose
 * audio can actually be acquired. A FAILED song qualifies — the process settled back to un-processed
 * server-side, so a retry is a real action.
 *
 * IT MUST TAKE THE MEDIA, not just its readiness: readiness is derived from the process gates, so a
 * metadata-only hit that can never be processed reads as un-acquired exactly like a fresh upload. Offering
 * Sing there takes the singer's turn (the queue-add comes first, by design) and the server then refuses the
 * process, leaving a turn nothing can ever make ready and no failure event because no job was enqueued.
 * `isProcessableSource` is the single shared authority; the server's own check asks it too.
 */
export function canProcess(m: Media, r: Readiness): boolean {
	return isProcessableSource(m.source) && (r === 'unacquired' || r === 'failed');
}

/**
 * What the Ready filter says when it has nothing to show. The group is query-scoped while a search is active
 * and the LIBRARY is not, so an unmatched search empties the group — and "no karaoke-ready songs yet" is then
 * a false statement about the whole library, which reads as the app having thrown the downloads away.
 */
export interface ReadyEmptyState {
	message: string;
	/** When set, the UI offers a one-tap way back to the full library (clears the search). */
	showAllCount: number | null;
}

export function readyEmptyState(opts: {
	searchActive: boolean;
	libraryCount: number;
	query?: string;
}): ReadyEmptyState {
	const { searchActive, libraryCount } = opts;
	// A genuinely empty library — this copy is correct here, and only here.
	if (libraryCount === 0) {
		return {
			// No control name and no mark: a plain string cannot hold one, and naming a button here is how
			// the copy came to point at a control that had been relabelled.
			message: 'No karaoke-ready songs yet.',
			showAllCount: null
		};
	}
	// The library HAS songs; they just don't match what is being searched. Say so, and name the way back.
	if (searchActive) {
		const q = (opts.query ?? '').trim();
		return {
			message: q ? `Nothing matches “${q}”.` : 'Nothing matches this search.',
			showAllCount: libraryCount
		};
	}
	// Not searching with a non-empty library means the group should have rendered rows, so this is unreachable
	// in practice — it returns something honest rather than the false "none yet".
	return { message: `${libraryCount} karaoke ${libraryCount === 1 ? 'song' : 'songs'} ready.`, showAllCount: null };
}

/**
 * Will this entry's media actually play right now? Client mirror of the server's own check, and the two MUST
 * agree or the phone narrates a different rotation than the TV performs.
 */
export function entryPlayable(media: Media | undefined, live?: { status: MediaStatus }): boolean {
	// A live status decides in BOTH directions: `ready` means the process landed before the catalog caught up,
	// anything else mid-flight means still processing. `failed` and `canceled` are terminal and say nothing
	// about playability, so the catalog answers for both.
	if (live && live.status === 'ready') return true;
	if (live && live.status !== 'failed' && live.status !== 'canceled') return false; // still processing
	if (!media) return false;
	return readyToSing(media);
}

/**
 * Which queued entry will ACTUALLY play next — the first PLAYABLE one, never the first in the list: the server
 * skips an entry whose stems are still processing (it keeps its fair slot but yields its turn), so "first"
 * promises a song the TV is about to skip past. `entries` must already be in rotation order.
 */
export function nextPlayableEntryId<E extends { id: string; mediaId: string }>(
	entries: E[],
	mediaOf: (mediaId: string) => Media | undefined,
	liveOf: (mediaId: string) => { status: MediaStatus } | undefined
): string | null {
	return entries.find((e) => entryPlayable(mediaOf(e.mediaId), liveOf(e.mediaId)))?.id ?? null;
}

/**
 * The media ids that belong in the "Processing" group, as an ORDER-INDEPENDENT set because the caller
 * re-hydrates each id from the catalog and imposes its own order.
 *
 * THE QUERY IS A LOAD-BEARING INPUT. With a search active this restricts to the server's query-matched
 * group, because re-deriving from the whole status map lets someone else's processing song appear under an
 * unrelated search — a row bypassing the search filter. With no search it is the full union of every
 * in-flight song, which is what guarantees a process you started is visible; `failed` is included, because a
 * dead process keeps its row, and `ready`/`canceled` are not.
 */
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
