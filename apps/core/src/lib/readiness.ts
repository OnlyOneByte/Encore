// Client-side mirror of the server's readiness axis (src/server/media/readiness.ts). Duplicated
// rather than imported because @encore/shared is the client/server contract and this is a derived
// view concern — but the classification MUST agree with the server's, so it is unit-tested here too.
import { isCooking, isCookableSource, readyToSing, type Media, type MediaStatus } from '@encore/shared';

export type Readiness = 'ready' | 'cooking' | 'failed' | 'unacquired';

export function readinessOf(m: Media): Readiness {
	// Gate-driven, and MUST stay byte-identical to the SERVER's copy (src/server/media/readiness.ts).
	// `isCooking` reads the cook gates rather than a single `stemStatus === 'queued'` check, so a song
	// mid-align (stems ready, lyrics queued) reads as cooking instead of falling through to unacquired.
	//
	// 'failed' is deliberately absent here: nothing in the catalog Media records a failure, and it
	// should not — a dead cook settles the status back to un-cooked (settleStemsGate), so the catalog's
	// honest answer for a failed song is 'unacquired'. Failure is a LIVE event, and displayReadiness
	// is where it belongs.
	if (readyToSing(m)) return 'ready';
	if (isCooking(m)) return 'cooking';
	return 'unacquired';
}

/**
 * Readiness for display, letting a LIVE media:status override the catalog. A `media:status` arrives
 * before the catalog copy is refreshed, so a song the singer just tapped "✨ Karaoke" on must read as
 * cooking immediately — otherwise the row visibly fails to respond to the tap.
 *
 * A `failed` status is surfaced rather than swallowed. It used to fall through to the catalog, where a
 * mid-flight `stemStatus` still read as cooking — so a dead cook went on saying "Making karaoke… 0%"
 * forever and the singer's only clue was a four-second toast. Reported only when the song is not
 * actually singable: a failed lyrics upgrade on an already-cooked song is not a failure the guest
 * needs, because they can still sing it.
 */
export function displayReadiness(m: Media, live?: { status: MediaStatus }): Readiness {
	if (live) {
		if (live.status === 'ready') return 'ready';
		if (live.status === 'failed') return readyToSing(m) ? 'ready' : 'failed';
		// A cancel is terminal but is NOT a failure — the catalog answers. settleStemsGate has already
		// put the media back to un-cooked, so this reads as 'unacquired' and the row offers Sing again.
		// Reporting 'failed' here would tell a guest who removed a song that the cook broke.
		if (live.status === 'canceled') return readinessOf(m);
		return 'cooking';
	}
	return readinessOf(m);
}

/**
 * Which card an entry in the ROTATION gets — the singer's own queue slot, not a search row.
 *
 * The bug this fixes: the phone chose between the cook-progress card and a plain queue row on
 * an "is it in flight" test, and a terminally failed cook is not in flight — so a dead turn rendered
 * byte-for-byte as an ordinary waiting turn. No progress bar, no chip, no sparkle, nothing that said
 * the cook had died, while `nextPlayable` held its slot on every pass and it never played. The
 * information was already on the client: the same live `failed` status drives the search row's
 * "Couldn't make karaoke" chip and the Cooking group's header. It just never reached the singer's own
 * card.
 *
 * Failure is decided by `displayReadiness`, NOT by a fresh `status === 'failed'` test, so this cannot
 * disagree with the row and the header that already read it. That also buys the one case a raw status
 * test gets wrong: a failed lyrics upgrade on an already-singable song reads as 'ready' there, and a
 * turn that WILL play must not be labelled broken.
 *
 * `ready` and `canceled` are plain: both are terminal and settled, the catalog answers for them, and
 * the entry is an ordinary waiting turn again.
 */
export type QueueCardKind = 'cooking' | 'failed' | 'plain';

export function queueCardKind(media: Media | undefined, live?: { status: MediaStatus }): QueueCardKind {
	if (!live) return 'plain';
	if (live.status === 'ready' || live.status === 'canceled') return 'plain';
	// A media missing from the catalog cannot be asked whether it is singable, so the live status is
	// the only witness — take it at its word rather than silently downgrading a dead cook to plain.
	if (live.status === 'failed') return media && displayReadiness(media, live) !== 'failed' ? 'plain' : 'failed';
	return 'cooking';
}

/**
 * Whether offering "make karaoke" makes sense: only for a song that is neither done nor in flight,
 * AND whose audio can actually be acquired.
 *
 * A FAILED song qualifies — that is the point of showing the state. The cook settled back to
 * un-cooked server-side, so a retry is a real action rather than a button that answers "already
 * cooked".
 *
 * IT TAKES THE MEDIA, not just its readiness, and that is the fix. Readiness alone cannot
 * answer this: it is derived from the cook gates, so a metadata-only Spotify hit — which can never be
 * cooked by anyone — reads as `'unacquired'` exactly like a fresh YouTube upload, and the row offered
 * Sing. Tapping it took the singer's turn (`cookAndQueue` queues first, by design) and only then did
 * the server refuse the cook, leaving a turn in the rotation that nothing could ever make ready: held
 * and skipped on every pass, forever, with no failure event because no job was ever enqueued. This is
 * the shape COMMON.md names — a per-item capability answered from a check that cannot see the item —
 * so the check now sees the item. `isCookableSource` is the single shared authority (fetchers.ts); the
 * server's `cookState` asks the same one.
 */
export function canCook(m: Media, r: Readiness): boolean {
	return isCookableSource(m.source) && (r === 'unacquired' || r === 'failed');
}

/**
 * What the Ready filter should say when it has nothing to show.
 *
 * The bug this fixes: the Ready group is query-scoped while a search is active (`readyResults`), but
 * the library is not — so searching for a song your library does not contain emptied the group and
 * the phone announced "No karaoke-ready songs yet". That is a statement about the whole library, and
 * it was FALSE: the songs were still there, one tap away behind a non-empty search box. Right after
 * tapping "✨ Karaoke" is exactly when a singer has a query in the box, so this read as the app
 * having thrown their downloads away.
 *
 * Pure so the wording and the offer-to-clear are unit-testable without a browser.
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
	// A genuinely empty library — the original copy is correct here, and only here.
	if (libraryCount === 0) {
		return {
			// Names the button as it actually reads. This said "tap ✨ Karaoke", but the control has been
			// labelled Sing since the two half-actions were merged — so the instruction pointed at a
			// button that does not exist. The emoji is gone too: this is a plain string, it cannot hold a
			// mark, and platform-dependent art in an instruction is worse than no art.
			message: 'No karaoke-ready songs yet — tap Sing on a search result to make one.',
			showAllCount: null
		};
	}
	// The library HAS songs; they just don't match what is being searched. Say so, and name the way back.
	if (searchActive) {
		const q = (opts.query ?? '').trim();
		const noun = libraryCount === 1 ? 'karaoke song' : 'karaoke songs';
		return {
			message: q
				? `None of your ${libraryCount} ${noun} match “${q}”.`
				: `None of your ${libraryCount} ${noun} match this search.`,
			showAllCount: libraryCount
		};
	}
	// Not searching and the library is non-empty → the group should have rendered rows, so this is
	// unreachable in practice. Return something honest rather than the false "none yet".
	return { message: `Your ${libraryCount} karaoke songs are ready to sing.`, showAllCount: null };
}

/**
 * Will this entry's media actually play right now? Client mirror of the server's
 * `rotation/isEntryReady` — the two MUST agree or the phone narrates a different rotation than the
 * TV performs. A live `media:status` wins over the catalog copy, which is a beat stale right after
 * a "✨ Karaoke" tap.
 */
export function entryPlayable(media: Media | undefined, live?: { status: MediaStatus }): boolean {
	// A live status decides in both directions: `ready` means the cook just landed and the catalog
	// copy hasn't caught up; anything else mid-flight means still cooking. `failed` and `canceled` are
	// terminal and say nothing about playability, so the catalog answers for both.
	if (live && live.status === 'ready') return true;
	if (live && live.status !== 'failed' && live.status !== 'canceled') return false; // still cooking
	if (!media) return false;
	return readyToSing(media);
}

/**
 * Which queued entry will ACTUALLY play next — the first one that is playable.
 *
 * The server's `nextPlayable()` skips an entry whose stems are still cooking (it keeps its fair
 * rotation slot but yields its turn), so treating "first in the list" as up-next lied whenever the
 * first entry was cooking: the phone promised a song the TV was about to skip straight past.
 * `entries` must already be in rotation order.
 */
export function nextPlayableEntryId<E extends { id: string; mediaId: string }>(
	entries: E[],
	mediaOf: (mediaId: string) => Media | undefined,
	liveOf: (mediaId: string) => { status: MediaStatus } | undefined
): string | null {
	return entries.find((e) => entryPlayable(mediaOf(e.mediaId), liveOf(e.mediaId)))?.id ?? null;
}

/**
 * The set of media ids that belong in the "Cooking" group — as an ORDER-INDEPENDENT `Set`, because
 * the caller re-hydrates each id into a row from the catalog and imposes its own order.
 *
 * The bug this fixes: with a search active, the group was re-derived from the WHOLE live status map
 * and the WHOLE catalog, ignoring the query. So a song someone else was cooking ("I want it that
 * way") showed up under an unrelated search ("never gonna give you up") — a cooking song bypassing
 * the search-match filter. The server already returns a query-scoped `cooking` group
 * (partitionSearch filters it through matchesQuery exactly like ready/raw); the phone was throwing
 * it away and rebuilding from scratch.
 *
 * So this makes the query the load-bearing input:
 *  - searchActive → restrict to `cookingResults`, the server's query-matched cooking group. A cooking
 *    song that does not match the query is absent; one that DOES match is present.
 *  - not searching → the full union of every in-flight song (live status map ∪ catalog), preserving
 *    the requirement that a cook you started is guaranteed visible when the box is empty. `failed` is
 *    included (a dead cook keeps its row); `ready`/`canceled` are excluded.
 *
 * Pure so it is unit-testable without a browser — the extraction is the fix's natural shape.
 */
export function cookingGroupIds(opts: {
	searchActive: boolean;
	cookingResults: Media[];
	mediaStatus: ReadonlyMap<string, { status: MediaStatus }>;
	mediaCatalog: ReadonlyMap<string, Media>;
	readiness: (m: Media) => Readiness;
}): Set<string> {
	const { searchActive, cookingResults, mediaStatus, mediaCatalog, readiness } = opts;
	if (searchActive) {
		// The server already scoped this to the query. Trust the wire; do NOT re-scan the catalog.
		return new Set(cookingResults.map((m) => m.id));
	}
	const ids = new Set<string>();
	for (const [id, s] of mediaStatus) if (s.status !== 'ready' && s.status !== 'canceled') ids.add(id);
	for (const [id, m] of mediaCatalog) if (readiness(m) === 'cooking') ids.add(id);
	return ids;
}
