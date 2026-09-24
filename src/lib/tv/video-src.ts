// Assigning `HTMLMediaElement.src` RELOADS the resource and resets `currentTime` to 0 even when the new URL is
// byte-identical, so the src may only be written when the resolved STRING changes. A markup binding cannot express
// that: catalog churn hands the slot a fresh Media object with equal fields and the identical string restarts the song.

/**
 * `prev` is the string last assigned to the element (null before the first assignment). A `playable: false` pass is
 * transient CHURN, not a clear — the element exists only while playable, so the src it holds must survive.
 */
export function nextVideoSrc(prev: string | null, next: string, playable: boolean): { src: string; changed: boolean } {
	// The only genuine "clear" is a real unmount, which never reaches this function.
	if (!playable) return { src: prev ?? '', changed: false };
	return { src: next, changed: prev !== next };
}
