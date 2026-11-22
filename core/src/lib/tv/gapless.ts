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
	// The entry `onEnded` moved past, until a server frame does too. Until then a frame naming it predates the TV's own
	// `ended`: a phone command made the server re-send its old pair (#1001).
	#endedFrom: string | null = null;
	// The intro card went up over a visible slot that was still LOADING (a skip, a missed preload), so the hold must end
	// back in `loading` unless the slot reported ready meanwhile, or the stage plays over an element with nothing in it.
	#introOverLoad = false;
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

	/** A server frame naming this entry is stale: the TV has already ended it and moved on. */
	isBehind(entryId: string | null | undefined): boolean {
		return !!entryId && entryId === this.#endedFrom;
	}

	/** The server's frame names the entry the TV already advanced to on its own `ended`: it is catching up. */
	isCatchingUp(entryId: string | null | undefined): boolean {
		return !!entryId && this.#endedFrom !== null && entryId === this.#current;
	}

	/**
	 * Server says current/upNext changed. Load current into visible; pre-warm upNext into hidden. A stale pair is
	 * ignored: applying it would reload the finished song over the one already playing.
	 */
	onNowPlaying(current: QueueEntry | null, upNext: QueueEntry | null): void {
		if (this.isBehind(current?.id)) return;
		this.#endedFrom = null;
		if (!current) {
			this.#current = null;
			this.#state = 'attract';
			return;
		}
		if (current.id !== this.#current) {
			this.#current = current.id;
			this.#state = 'loading'; // visible slot must (re)load the new current
			this.#introOverLoad = false;
		}
		if (upNext && upNext.id !== this.#warmingId && upNext.id !== this.#readyId) {
			this.#warmingId = upNext.id;
			this.#readyId = null;
		} else if (!upNext) {
			this.#warmingId = null;
			this.#readyId = null;
		}
	}

	/**
	 * Which of the server's pair each slot carries. After `onEnded` the controller is one server frame AHEAD of it: it
	 * already plays `upNext`, so mapping the stale pair would hand the warmed slot the song that just ended, throw its
	 * buffer away and cold-load the next song once the frame lands. In the missed-window case the visible slot loads
	 * `upNext` right away and the partly warmed hidden slot is dropped, rather than replaying the ended song until then.
	 */
	slotEntries<T extends { id: string }>(current: T | null, upNext: T | null): { visible: T | null; hidden: T | null } {
		if (upNext && upNext.id === this.#current && current?.id !== upNext.id) return { visible: upNext, hidden: null };
		return { visible: current, hidden: upNext };
	}

	/** Visible slot reports it can play through. */
	onVisibleReady(): void {
		if (this.#state === 'loading') this.#state = 'playing';
		if (this.#state === 'interstitial') this.#introOverLoad = false;
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
		// The FIRST entry ended in this window, kept until a server frame clears it: when song 2 errors before the server's
		// frame lands, this runs again, and the server's stale frames still name song 1.
		this.#endedFrom ??= this.#current;
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
			this.#state = 'interstitial'; // page shows the intro card, then -> playing
			this.#introOverLoad = false; // the warmed slot is buffered already
		} else {
			// missed the window: load upNext into (new) visible slot now
			this.#current = upNext.id;
			this.#state = 'loading';
		}
		return this.state;
	}

	/** The intro card is up and its hold ending would start the song, not hold on a slot that is still loading. */
	get introEndsInSong(): boolean {
		return this.#state === 'interstitial' && !this.#introOverLoad;
	}

	/** Interstitial timer elapsed → playing. */
	onInterstitialDone(): void {
		if (this.#state === 'interstitial') this.#state = this.#introOverLoad ? 'loading' : 'playing';
		this.#introOverLoad = false;
	}

	/**
	 * Hold on the song-intro card. `onEnded` reaches the interstitial via a gapless swap, which exists only between two
	 * songs, so the FIRST song of a session and a server-driven change (a skip) need their own way in.
	 */
	enterInterstitial(): void {
		if (this.#state === 'playing' || this.#state === 'loading') {
			this.#introOverLoad = this.#state === 'loading';
			this.#state = 'interstitial';
		}
	}

	/** Mark the current entry's media as not-ready (held slot): show waiting. */
	enterWaiting(): void {
		this.#state = 'waiting';
	}
}
