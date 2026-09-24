// Two-player gapless controller, modelling the A/B swap as pure state (docs/ARCHITECTURE.md).
//
// INVARIANT: the VISIBLE slot plays `current`, the HIDDEN slot pre-buffers `upNext`, and `ended` swaps roles only if
// the hidden slot is warmed for the right entry — one composited frame, no network fetch at transition time.

import type { QueueEntry } from '$lib/contract';

export type Slot = 'A' | 'B';
export type TvState = 'attract' | 'loading' | 'playing' | 'interstitial' | 'waiting';

export interface SlotAssignment {
	visible: Slot;
	hidden: Slot;
	visibleEntryId: string | null; // what the visible slot should show/play
	hiddenEntryId: string | null; // what the hidden slot should pre-warm
}

export class GaplessController {
	#visible: Slot = 'A';
	#current: string | null = null; // entryId in the visible slot
	#warmingId: string | null = null; // entryId the hidden slot is loading
	#readyId: string | null = null; // entryId the hidden slot has buffered (gapless-ready)
	// Exposed READ-ONLY and set only through this controller's own transition methods: a public writable field lets any
	// caller stomp the state machine from outside.
	#state: TvState = 'attract';

	get visible(): Slot {
		return this.#visible;
	}
	get hidden(): Slot {
		return this.#visible === 'A' ? 'B' : 'A';
	}
	get currentId(): string | null {
		return this.#current;
	}
	get state(): TvState {
		return this.#state;
	}

	assignment(): SlotAssignment {
		return {
			visible: this.#visible,
			hidden: this.hidden,
			visibleEntryId: this.#current,
			hiddenEntryId: this.#warmingId
		};
	}

	/** Server says current/upNext changed. Load current into visible; pre-warm upNext into hidden. */
	onNowPlaying(current: QueueEntry | null, upNext: QueueEntry | null): void {
		if (!current) {
			this.#current = null;
			this.#state = 'attract';
			return;
		}
		if (current.id !== this.#current) {
			this.#current = current.id;
			this.#state = 'loading'; // visible slot must (re)load the new current
		}
		// pre-warm the hidden slot for upNext (unless already warming/ready for it)
		if (upNext && upNext.id !== this.#warmingId && upNext.id !== this.#readyId) {
			this.#warmingId = upNext.id;
			this.#readyId = null;
		} else if (!upNext) {
			this.#warmingId = null;
			this.#readyId = null;
		}
	}

	/** Visible slot reports it can play through. */
	onVisibleReady(): void {
		if (this.#state === 'loading') this.#state = 'playing';
	}

	/** Hidden slot reports it's buffered for its warming target. */
	onHiddenReady(entryId: string): void {
		if (entryId === this.#warmingId) this.#readyId = entryId;
	}

	/** Is the hidden slot gapless-ready for the given upNext entry? */
	isNextReady(upNextId: string | null): boolean {
		return !!upNextId && this.#readyId === upNextId;
	}

	/**
	 * No upNext -> attract; hidden warmed it -> SWAP (gapless); else loading (missed the preload window). Returns the new
	 * state for the caller to render; the interstitial hold is the page's timer.
	 */
	onEnded(upNext: QueueEntry | null): TvState {
		if (!upNext) {
			this.#current = null;
			this.#state = 'attract';
			return this.state;
		}
		if (this.isNextReady(upNext.id)) {
			// swap roles — the warmed hidden slot is already buffered at t=0
			this.#visible = this.hidden;
			this.#current = upNext.id;
			this.#warmingId = null;
			this.#readyId = null;
			this.#state = 'interstitial'; // page shows brief "Next up", then -> playing
		} else {
			// missed the window: load upNext into (new) visible slot now
			this.#current = upNext.id;
			this.#state = 'loading';
		}
		return this.state;
	}

	/** Interstitial timer elapsed → playing. */
	onInterstitialDone(): void {
		if (this.#state === 'interstitial') this.#state = 'playing';
	}

	/**
	 * Hold on the song-intro card from a state that is otherwise ready to play. `onEnded` reaches the interstitial via a
	 * gapless swap, which exists only between two songs, so the FIRST song of a session needs its own way in.
	 */
	enterInterstitial(): void {
		if (this.#state === 'playing' || this.#state === 'loading') this.#state = 'interstitial';
	}

	/** Mark the current entry's media as not-ready (held slot): show waiting. */
	enterWaiting(): void {
		this.#state = 'waiting';
	}
}
