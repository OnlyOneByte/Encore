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
