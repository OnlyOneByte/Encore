// KEEP THE TV AWAKE while a song is on stage, or the OS screensaver blanks the room mid-song.
// See docs/FRONTEND.md#wake-lock-and-reload-resume.

/**
 * Takes a screen wake lock and holds it until the returned teardown runs. `undefined` when the platform has no Wake
 * Lock API: it is secure-context only, so every plain-HTTP LAN room and SSR land here and the screen keeps the OS
 * default sleep. 'screen' is the only lock type that keeps the display on.
 */
export function keepScreenAwake(): (() => void) | undefined {
	if (typeof navigator === 'undefined' || !navigator.wakeLock) return;

	let sentinel: WakeLockSentinel | null = null;
	// `sentinel` is null for the whole in-flight window, so without this flag a mid-flight `visibilitychange` issues a
	// SECOND request and leaks the first held lock past the song's end.
	let acquiring = false;
	let released = false;

	const acquire = () => {
		// A pending, in-flight or held lock needs no second request; a released sentinel is spent.
		if (acquiring || (sentinel && !sentinel.released)) return;
		acquiring = true;
		navigator
			.wakeLock!.request('screen')
			.then((s) => {
				if (released) {
					// Torn down while the request was in flight — do not leak it.
					s.release().catch(() => {});
					return;
				}
				sentinel = s;
			})
			// A rejected request (policy, low battery) must not throw; the screen falls back to default sleep.
			.catch(() => {})
			.finally(() => {
				acquiring = false;
			});
	};

	// The platform DROPS the lock whenever the document hides and never restores it, so without this the feature works
	// exactly once. A hide fires `visibilitychange` as well, hence the state check.
	const onVisibility = () => {
		if (document.visibilityState === 'visible') acquire();
	};

	acquire();
	document.addEventListener('visibilitychange', onVisibility);

	return () => {
		released = true;
		document.removeEventListener('visibilitychange', onVisibility);
		sentinel?.release().catch(() => {});
		sentinel = null;
	};
}
