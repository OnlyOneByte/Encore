// RESTORING THE AUTOPLAY POLICY THIS HARNESS CANNOT ENFORCE.
//
// The product's hardest playback rule is that a television grants no gesture, so the TV must notice a refused
// `play()` and show its tap-to-start affordance. `docs/E2E.md#autoplay` is explicit that the suite must NOT pass
// `--autoplay-policy=no-user-gesture-required`, because proving playback with the policy relaxed proves it in an
// environment the product never ships into.
//
// Measured on this box (headless chromium-1223, macOS), three ways, by two independent agents:
//   * an unmuted `play()` succeeds from a cold load with no input;
//   * `--autoplay-policy=user-gesture-required`, `=document-user-activation-required` and `--headless=old`
//     are all IGNORED;
//   * `navigator.userActivation.hasBeenActive` is already `true` ~271ms after load with nothing touching the
//     page — and true on a cold `about:blank` — which is why the flag changes nothing.
// Playwright compounds it: CDP evaluations carry `userGesture: true`, so merely READING the page grants the
// frame sticky activation.
//
// So the blocked state is unreachable by configuration, and a spec that simply asserts "the hint appeared"
// would pass for the wrong reason forever. This re-imposes the policy IN-PAGE instead, before app code runs.
//
// WHAT THIS IS AND IS NOT. It is a faithful stand-in for the ONE rule the app reacts to: an unmuted `play()`
// rejects with `NotAllowedError` until real activation arrives. It is NOT the browser's policy engine — it does
// not model per-origin engagement scores, it does not gate muted playback (real policy allows muted autoplay,
// and so does this), and it cannot prove anything about a browser that blocks for a different reason. A spec
// using this is asserting that the APP HANDLES a refusal correctly, which is the testable half; it is not
// asserting that this Chromium refuses. Say which you mean in the spec.
import type { Page } from '@playwright/test';

export interface AutoplayPolicyOptions {
	/** Also start every `AudioContext` suspended, so a resume needs activation too. */
	gateAudioContext?: boolean;
}

/**
 * Install before navigation. `addInitScript` runs on every document in the page, including reloads, which the
 * reload-resume specs depend on.
 *
 * ONLY A TRUSTED EVENT COUNTS. The listeners check `event.isTrusted`, so a synthetic `el.click()` or a
 * dispatched `PointerEvent` unblocks nothing — which is the property that makes a tap-to-start test meaningful,
 * since a synthetic click grants no user activation in a real browser either.
 */
export async function requireActivationForPlayback(
	page: Page,
	{ gateAudioContext = false }: AutoplayPolicyOptions = {}
): Promise<void> {
	await page.addInitScript(
		({ gateAudioContext }) => {
			let activated = false;
			const activate = (e: Event) => {
				if (e.isTrusted) activated = true;
			};
			for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown'] as const) {
				window.addEventListener(type, activate, { capture: true, passive: true });
			}
			// Exposed so a spec can assert the PREMISE it depends on rather than assuming it.
			Object.defineProperty(window, '__autoplayBlocked', { get: () => !activated, configurable: true });

			const nativePlay = HTMLMediaElement.prototype.play;
			HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
				// Muted playback is permitted by real policy, so it is permitted here — a TV that mutes to get
				// moving would not be exercising the refusal path at all.
				if (activated || this.muted || this.volume === 0) return nativePlay.call(this);
				// The exact error the app branches on. A plain Error would take a different code path.
				return Promise.reject(
					new DOMException("play() failed because the user didn't interact with the document first.", 'NotAllowedError')
				);
			};

			if (!gateAudioContext) return;
			// A real AudioContext constructed without activation starts `suspended` and stays there until a
			// gesture. Emulated narrowly: resume() is a no-op that leaves state 'suspended' until activation.
			const Ctor =
				window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (!Ctor) return;
			const nativeResume = Ctor.prototype.resume;
			Ctor.prototype.resume = function resume(this: AudioContext) {
				if (activated) return nativeResume.call(this);
				return Promise.resolve();
			};
		},
		{ gateAudioContext }
	);
}

/** The premise check. Assert this BEFORE asserting the app's reaction, so a broken shim cannot read as a pass. */
export async function autoplayIsBlocked(page: Page): Promise<boolean> {
	return page.evaluate(() => (window as unknown as { __autoplayBlocked?: boolean }).__autoplayBlocked === true);
}
