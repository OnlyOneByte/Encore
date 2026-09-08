// Whether a TvPlayer slot's master element should be PLAYING, PAUSED, or left alone — and
// specifically why "left alone" has to be a third answer rather than folded into pause.
//
// THE BUG THIS CLOSES. The master's src is assigned imperatively from an effect (see `video-src.ts`
// for why it cannot be a markup binding), while play/pause lived in a *different* effect that knew
// nothing about it. Svelte runs effects in declaration order, and the play/pause effect was declared
// first — so on the flush that mounts a slot, `play()` was called on an element with no src at all,
// and the src was assigned immediately afterwards.
//
// That is not merely early. Assigning `src` invokes the HTML media load algorithm, which explicitly
// "set[s] the paused attribute to true" — so the load UNDOES the play() and rejects its promise with
// AbortError. `.catch(() => {})` then swallowed the one piece of evidence. Nothing re-ran the
// play/pause effect afterwards (none of its dependencies had changed), so the element sat at
// readyState 4, fully buffered, correct duration, no error — and permanently paused at 0.
//
// Every reported symptom followed from that one paused element, because `ontimeupdate` never fires on
// an element that never plays:
//   • no sound, from an instrumental that was provably fine on disk and decodable in the browser;
//   • the server's `playback.positionSec` stuck at 0, because telemetry is sent FROM `ontimeupdate`;
//   • the phone's progress bar counting up from 0 and snapping back to 0 on every pause, because it
//     interpolates from that 0 anchor;
//   • the TV lyrics appearing to work, then jumping to the beginning on pause and back on resume —
//     LyricsOverlay interpolates forward from `positionSec` with a wall clock while `playing`, and
//     renders the raw anchor (0) when paused.
//
// Measured, both in the running app and in an isolated element in the same browser: play()-then-src
// leaves `paused=true, currentTime=0, webkitAudioDecodedByteCount=8641` (the preload only);
// src-then-play reaches `currentTime=3.91, decodedByteCount=216798`. The app's live reading was
// byte-identical to the broken trial.
//
// SO THE PRECONDITION IS MADE EXPLICIT AND REACTIVE. The transport decision now depends on whether
// the element is actually holding its media, which means the effect re-runs when the src lands
// instead of racing it. Declaration order stops being load-bearing.
//
// Pure (no DOM) so the decision is unit-testable without a real media element, matching `video-src.ts`
// and `guide-sync.ts`.

/** What to do to the media element right now. */
export type Transport = 'play' | 'pause' | 'idle';

export interface TransportInputs {
	/**
	 * Is the element holding the src it is supposed to hold? This is the load-bearing input: `play()`
	 * before the src is assigned is undone by the assignment itself, so a slot whose src has not landed
	 * yet must be left ALONE rather than played.
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
 * Decide the transport for one slot's master element.
 *
 * `idle` means "do nothing" — not "pause". The distinction matters on the mount flush: pausing an
 * element that has not been given its media yet is harmless but pointless, whereas PLAYING it is the
 * defect, and returning a definite `pause` would invite a caller to treat `idle` and `pause` as
 * interchangeable and reintroduce the race from the other side.
 */
export function transportFor({ hasSrc, playable, active, visible, playing }: TransportInputs): Transport {
	if (!playable || !hasSrc) return 'idle';
	return active && visible && playing ? 'play' : 'pause';
}

/**
 * Is the element holding the src for THIS media — not merely holding *some* src?
 *
 * This is the input `transportFor.hasSrc` actually wants (see its doc: "Is the element holding the src
 * it is supposed to hold?"). The TvPlayer derived used to pass `!!currentSrc`, which only answers "has
 * this slot EVER held a src" — true from the first song onward. On a song change `currentSrc` still
 * holds the PREVIOUS song's URL (`TvPlayer.svelte` deliberately never clears it, and only rewrites it
 * on a playable pass), so `!!currentSrc` stayed true across the change and the transport stayed `'play'`
 * with an unchanged VALUE — a memoized `$derived` does not re-run its effect on an unchanged value, so
 * nothing re-called `play()` after the new src landed and the master sat paused at 0. That is #374.
 *
 * `held` is the src the element currently holds (TvPlayer's `currentSrc` bookkeeping); `wanted` is what
 * the current media resolves to now (`fileSrc(media)`), or `null`/`''` when there is no media. They
 * match only when the element is holding the CURRENT song's src, so a song change reads `false` until
 * the assign effect writes the new src — which is exactly the `false -> true` edge that re-arms the
 * transport effect after the src has landed rather than racing it, BUT ONLY WHEN THE RESOLVED SRC
 * DIFFERS. Two turns of the SAME song resolve to the byte-identical src, so `held === wanted` stays
 * `true` continuously and there is NO `false -> true` edge across a same-song advance — the element is
 * paused by `ended` and never re-armed. That same-song hole is #701, and it is why the transport reader
 * scopes its input to the ENTRY, not the src, via `slotHoldsSong` below.
 *
 * Pure and string-based (no DOM, no `Media` coupling) so it is unit-testable without a real element,
 * matching `video-src.ts` and `transportFor` itself.
 */
export function slotHoldsSrc(held: string | null | undefined, wanted: string | null | undefined): boolean {
	return !!held && !!wanted && held === wanted;
}

/**
 * Is the element holding the src for THIS QUEUE ENTRY — not merely for a song with this src?
 *
 * `slotHoldsSrc` compares src strings, which is blind to the one distinction #701 turns on: two turns
 * of the SAME song in the queue are two separate `QueueEntry`s with distinct client-minted ids, but
 * their `fileSrc(media)` resolves to the byte-identical string. So across a same-song advance
 * `slotHoldsSrc(currentSrc, fileSrc(media))` stays `true` on both sides, the transport `$derived` keeps
 * the same `'play'` value, and its effect never re-runs — while `ended` has already paused the element
 * and the byte-identical src reset `currentTime` to 0. The room goes silent at 0 with no affordance.
 *
 * The token is `` `${entryId}|${src}` `` — the entry id makes turn 2 a DIFFERENT wanted token from
 * turn 1 even though the src is unchanged, and the src component keeps every property `slotHoldsSrc`
 * had (a non-playable / src-less slot has no wanted token and reads `false`, and a genuine
 * two-different-songs change still differs). `held` is TvPlayer's shadow of the token the element last
 * settled on (written in the SAME assign effect that writes `currentSrc`, so the two can never
 * diverge); `wanted` is the token the current entry resolves to now. They match only when the element
 * has already settled on THIS entry's src, so a same-song advance reads `false` until the assign effect
 * records the new entry — a genuine `idle -> play` edge WITHOUT rewriting the byte-identical src, which
 * `TvPlayer.svelte`'s per-song-change note warns reloads the playing song (and is why the shadow is not
 * simply cleared on a song change).
 *
 * Pure and string-based (no DOM, no `Media` coupling), matching `slotHoldsSrc` and `transportFor`.
 */
export function slotHoldsSong(held: string | null | undefined, wanted: string | null | undefined): boolean {
	return !!held && !!wanted && held === wanted;
}

/**
 * The token `slotHoldsSong` compares: an entry-scoped identity for the src an element holds or wants.
 *
 * `null` when the slot has nothing playable to hold (no entry, or no resolved src) — so the token is
 * absent exactly when `slotHoldsSrc` would have returned `false` for lack of a `wanted`, preserving
 * that leg of the decision. When both are present it is `` `${entryId}|${src}` ``, which differs
 * between two turns of the same song (distinct `entryId`) and between two different songs (distinct
 * `src`), and is stable for one entry across the identity churn `currentSrc` already survives.
 */
export function songToken(entryId: string | null | undefined, src: string | null | undefined): string | null {
	return entryId && src ? `${entryId}|${src}` : null;
}
