// Whether a TvPlayer slot's master element should be PLAYING, PAUSED, or left alone. Pure (no DOM, no
// `Media` coupling) so each decision is unit-testable without a media element.

/** What to do to the media element right now. */
export type Transport = 'play' | 'pause' | 'idle';

export interface TransportInputs {
	/**
	 * Load-bearing: assigning `src` runs the HTML media load algorithm, which sets `paused`, so a `play()`
	 * issued before the src lands is undone by the assignment and rejects with AbortError — leaving the
	 * element buffered and permanently paused at 0. Making the precondition REACTIVE is what stops effect
	 * declaration order from being load-bearing.
	 */
	hasSrc: boolean;
	/** Is there media, and is it playable? A slot with nothing to play has no transport. */
	playable: boolean;
	/** Is this the playing slot, rather than the hidden pre-warming one? */
	active: boolean;
	/** Is this slot the one on screen? */
	visible: boolean;
	/** The room's play/pause, from `playback:state.isPlaying`. */
	playing: boolean;
}

/**
 * Decide the transport for one slot's master element. `idle` means "do nothing", NOT "pause" — a definite
 * `pause` would invite callers to treat the two as interchangeable and play a src-less element.
 */
export function transportFor({ hasSrc, playable, active, visible, playing }: TransportInputs): Transport {
	if (!playable || !hasSrc) return 'idle';
	return active && visible && playing ? 'play' : 'pause';
}

/** Src-string comparison only, so it is blind to two turns of the same song. Prefer `slotHoldsSong`. */
export function slotHoldsSrc(held: string | null | undefined, wanted: string | null | undefined): boolean {
	return !!held && !!wanted && held === wanted;
}

/**
 * Is the element holding the src for THIS QUEUE ENTRY? Scoped to the ENTRY, not the src: two turns of the
 * same song resolve to a byte-identical src, so a src-only comparison stays `true` across the advance, the
 * transport `$derived` keeps its `'play'` value and its effect never re-runs — while `ended` has already
 * paused the element. Entry scoping gives a genuine `idle -> play` edge WITHOUT rewriting the byte-identical
 * src, which would reload the playing song.
 */
export function slotHoldsSong(held: string | null | undefined, wanted: string | null | undefined): boolean {
	return !!held && !!wanted && held === wanted;
}

/**
 * The token `slotHoldsSong` compares: `` `${entryId}|${src}` ``, or `null` when the slot has nothing
 * playable. Differs between two turns of one song and between two songs, and is stable for one entry.
 */
export function songToken(entryId: string | null | undefined, src: string | null | undefined): string | null {
	return entryId && src ? `${entryId}|${src}` : null;
}
