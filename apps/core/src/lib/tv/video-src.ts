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
// `fileSrc`/`playbackRef` are pure in the media's fields, so two DISTINCT Media
// objects with equal fields resolve to the same string and this must report `changed: false`. A real
// instrumental swap resolves to a different string and must report `changed: true`.
//
// A KEY SHIFT NO LONGER AFFECTS THE SRC. It once selected a pre-rendered per-key file, so changing key
// reassigned the element and restarted the song from 0; transposition now happens in the browser
// (see `pitch-shift.ts`), so the same file keeps playing and only the worklet's ratio moves. That
// removes a whole class of this bug rather than adding one.
//
// Pure and string-based (no DOM) so the decision is unit-testable without a real media element.

/**
 * Decide the next src for a slot given the src it currently holds and the freshly-resolved src.
 *
 * `prev` is the string last assigned to the element (or null before the first assignment). `next` is
 * what the current media resolves to now (`''` when the slot has nothing playable). `playable` is
 * `media && isPlayable(media)`: when false the slot has nothing to play THIS pass, which — because the
 * element only exists while playable — is a transient churn pass and must never clear a src the element
 * still holds (see #251, and the `!playable` branch below). `changed` is true only when the element must actually be
 * written, so an unchanged song is a no-op and never reloads, and a not-playable pass is never a clear.
 */
export function nextVideoSrc(
	prev: string | null,
	next: string,
	playable: boolean
): { src: string; changed: boolean } {
	// Nothing playable this pass: keep whatever the element holds, never write. The only genuine
	// "clear" is a real unmount, which never reaches this function.
	if (!playable) return { src: prev ?? '', changed: false };
	return { src: next, changed: prev !== next };
}
