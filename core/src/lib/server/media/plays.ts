// Play tracking (retention follow-up) — records WHEN a song was last actually sung, since
// `library.lastPlayedAt` existed but nothing incremented it, so eviction fell back to oldest-added
// (backwards: a song added months ago and sung weekly would evict before one never played).
//
// DEDUPES on ENTRY id, not media id: `emitNowPlaying` is the right hook (every playback transition
// funnels through it) but also re-emits with no change (a finished process re-broadcasts so the TV
// preloads the next-ready song) — counting every emit would inflate plays on an unrelated finish.
// The same song queued twice in one night is two entries and genuinely two plays; one entry
// re-emitted five times is one.
//  Pure tracker, injectable sink — testable without a filesystem.

/** Notified once per genuinely-new current entry. */
export type PlaySink = (mediaId: string, entryId: string) => void;

export class PlayTracker {
	#lastEntryId: string | null = null;
	#sink: PlaySink;

	constructor(sink: PlaySink) {
		this.#sink = sink;
	}

	/** Call on every nowplaying emit — fires the sink only when the current entry actually CHANGED to
	 *  a real entry; a repeat emit or a transition to nothing-playing records no play. */
	onNowPlaying(entry: { id: string; mediaId: string } | null): void {
		if (!entry) {
			// Clear rather than leave stale: restarting the SAME entry later must count as a fresh play.
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
