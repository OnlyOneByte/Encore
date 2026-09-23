// Whether a TvPlayer slot must reassign its src, and the string to assign. Assigning
// `HTMLMediaElement.src` RELOADS the resource and resets `currentTime` to 0 even when the new URL is
// byte-identical, so the src may only be written when the resolved STRING changes. A markup binding cannot
// express that: catalog churn hands the slot a fresh Media object with equal fields, the binding
// re-evaluates, and the identical string restarts the playing song from 0. A key shift does not reach the
// src at all — transposition happens in the worklet. Pure and string-based, so it tests without an element.

/**
 * `prev` is the string last assigned to the element (null before the first assignment); `next` is what the
 * current media resolves to now. A `playable: false` pass is transient CHURN, not a clear — the element only
 * exists while playable, so the src it holds must survive.
 */
export function nextVideoSrc(prev: string | null, next: string, playable: boolean): { src: string; changed: boolean } {
	// The only genuine "clear" is a real unmount, which never reaches this function.
	if (!playable) return { src: prev ?? '', changed: false };
	return { src: next, changed: prev !== next };
}
