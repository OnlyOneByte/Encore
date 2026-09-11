// Play tracking (retention follow-up) — record WHEN a song was last actually sung.
//
// Why: retention's eviction plan needs a recency signal. `library.lastPlayedAt` existed in the sidecar
// but nothing incremented it, so eviction fell back to `addedAt` (oldest-added-first) — a song added
// months ago and sung weekly would be evicted before one added yesterday and never played, backwards.
//
// Design — DEDUPE on ENTRY id, not media id:
//   - `emitNowPlaying` is the single choke point every playback transition funnels through (the right
//     hook), but it is also re-emitted without a change (a finished process re-broadcasts nowplaying so
//     the TV preloads the now-ready song). Counting every emit would inflate play count whenever an
//     unrelated song finished processing.
//   - Entry id, not media id: the same song queued twice in one night is two entries and genuinely two
//     plays, while one entry re-emitted five times is one.
//
// Pure tracker, injectable sink — testable without a filesystem.

/** Notified once per genuinely-new current entry. */
export type PlaySink = (mediaId: string, entryId: string) => void;

export class PlayTracker {
	#lastEntryId: string | null = null;
	#sink: PlaySink;

	constructor(sink: PlaySink) {
		this.#sink = sink;
	}

	/**
	 * Call on every nowplaying emit. Fires the sink only when the current entry actually CHANGED to a
	 * real entry — a repeat emit, or a transition to nothing-playing, records no play.
	 */
	onNowPlaying(entry: { id: string; mediaId: string } | null): void {
		if (!entry) {
			// Nothing playing. Clear, so that re-starting the SAME entry later (restart, or a rewind
			// through an empty queue) counts as a fresh play rather than being swallowed as a dupe.
			this.#lastEntryId = null;
			return;
		}
		if (entry.id === this.#lastEntryId) return; // same entry re-emitted — not a new play
		this.#lastEntryId = entry.id;
		this.#sink(entry.mediaId, entry.id);
	}

	/** Exposed for assertions; the tracker's whole state is which entry it last counted. */
	lastCountedEntryId(): string | null {
		return this.#lastEntryId;
	}
}

/** The sidecar fields a play updates. Pure, so the increment rule is testable on its own. */
export function bumpPlay(
	library: { playCount: number; lastPlayedAt: number | null },
	now: number
): { playCount: number; lastPlayedAt: number } {
	return { playCount: library.playCount + 1, lastPlayedAt: now };
}
