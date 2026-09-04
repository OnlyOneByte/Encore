// Whether a TvPlayer slot must reassign its <video> src — and the string to assign if so.
//
// WHY THIS IS ITS OWN PURE FUNCTION. Assigning `HTMLMediaElement.src` RELOADS the resource and resets
// `currentTime` to 0 EVEN when the new URL string is byte-identical to the old one. So the src must be
// written only when the resolved string actually changes. The bug this closes (Bug A): an unrelated
// cook finishing rebroadcasts a full `queue:sync`, the TV rebuilt its media catalog into fresh object
// identities, `syncSlots` wrote a NEW Media object with identical field values into the slot, and a
// markup binding `src={fileSrc(media)}` re-evaluated and reassigned the identical string — restarting
// the playing song from 0.
//
// `fileSrc`/`playbackRef`/`keyedMediaRef` are pure in the media's fields, so two DISTINCT Media
// objects with equal fields resolve to the same string and this must report `changed: false`. A real
// instrumental swap or key-shift resolves to a different string and must report `changed: true`.
//
// Pure and string-based (no DOM) so the decision is unit-testable without a real media element.

/**
 * Decide the next src for a slot given the src it currently holds and the freshly-resolved src.
 *
 * `prev` is the string last assigned to the element (or null before the first assignment). `next` is
 * what the current media resolves to now (`''` when the slot has nothing playable). `changed` is true
 * only when the element must actually be written, so an unchanged song is a no-op and never reloads.
 */
export function nextVideoSrc(prev: string | null, next: string): { src: string; changed: boolean } {
	return { src: next, changed: prev !== next };
}
