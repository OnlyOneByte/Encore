// Client-side mirror of the server's readiness axis (src/server/media/readiness.ts). Duplicated
// rather than imported because @encore/shared is the client/server contract and this is a derived
// view concern — but the classification MUST agree with the server's, so it is unit-tested here too.
import { isPlayable, readyToSing, type Media, type MediaStatus } from '@encore/shared';

export type Readiness = 'ready' | 'cooking' | 'unacquired';

export function readinessOf(m: Media): Readiness {
	// FINISHED, not merely playable — the client mirrors the server's gate table so the two surfaces
	// cannot disagree about which group a song belongs to (they did, and it rendered in both).
	if (readyToSing(m)) return 'ready';
	if (m.stemStatus === 'queued') return 'cooking';
	return 'unacquired';
}

/**
 * Readiness for display, letting a LIVE media:status override the catalog. A `media:status` arrives
 * before the catalog copy is refreshed, so a song the singer just tapped "✨ Karaoke" on must read as
 * cooking immediately — otherwise the row visibly fails to respond to the tap.
 */
export function displayReadiness(m: Media, live?: { status: MediaStatus }): Readiness {
	if (live) {
		if (live.status === 'ready') return 'ready';
		if (live.status !== 'failed') return 'cooking';
	}
	return readinessOf(m);
}

/** Whether offering "make karaoke" makes sense: only for a song that is neither done nor in flight. */
export function canCook(r: Readiness): boolean {
	return r === 'unacquired';
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

export function readyEmptyState(opts: { searchActive: boolean; libraryCount: number; query?: string }): ReadyEmptyState {
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
export function entryPlayable(
	media: Media | undefined,
	live?: { status: MediaStatus }
): boolean {
	// A live status decides in both directions: `ready` means the cook just landed and the catalog
	// copy hasn't caught up; anything else mid-flight means still cooking. `failed` says nothing about
	// playability, so the catalog answers.
	if (live && live.status === 'ready') return true;
	if (live && live.status !== 'failed') return false; // queued/downloading/separating/aligning
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
