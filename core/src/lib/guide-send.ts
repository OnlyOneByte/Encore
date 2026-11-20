/*
 * THE GUIDING-TRACK SEND — a throttle with a trailing edge, plus the one rule that makes the control honest: a
 * LOCAL DRAFT MAY NOT OUTLIVE A DROPPED COMMAND.
 *
 * `send` is `RoomLink.command`'s boolean. FALSE means the socket was absent or not open, so the server never
 * heard it, and a PLAYER command is not resent on resync the way a queue add is — `QueueStore.resendPending`
 * has no counterpart on this path — so dropped really does mean lost. There is nothing to be optimistic about,
 * which is why a drop clears the draft instead of holding it. That is the rule `/queue`'s `keyDraft` already
 * states for the ± keycaps, applied to the one other control that holds an optimistic value.
 *
 * The defect it exists for is on record in docs/UI-REVIEW.md finding C: the control followed the finger through a
 * drag the room never heard, and then sprang back on release — which reads as the app being broken rather than as
 * the network being down. THIS MODULE OWNS THE DRAFT HALF of that, which is the spring-back and the readout;
 * holding the primitive's own copy of the value still is `GuidingTrack.svelte`'s, and neither half fixes the
 * finding alone. The note in `input` below records what was measured when only this half existed.
 *
 * WHY A MODULE rather than four `let`s in the route. This is arithmetic over a clock and a boolean, and the
 * component-mount harness is gone (bunfig.toml records why), so logic left in a `.svelte` file is logic no bun
 * test can reach — only a source scan, which cannot catch a wrong trailing value. The clock and the timer are
 * injectable for the same reason `WsClient`'s are: a test drives the trailing edge without waiting out real
 * milliseconds. What stays in the route is the reactive half — the `$state` draft and the effect that drops it
 * when the room agrees.
 */

/** Whatever the injected timer hands back. It is only ever passed straight to `clearTimeoutFn`, so its shape is
 *  the injector's business — a test's fake handle may be an integer or an object as it pleases. */
type TimerHandle = unknown;

export interface GuideSendOptions {
	/** Send the level as the control reads it, 0..100. Returns whether it reached the wire. */
	send: (pct: number) => boolean;
	/** The level to SHOW, or null for "no local opinion — show the room's". Called on every decision, including
	 *  the ones taken on a timer, and a repeated value is deliberately not filtered: the caller writes it into a
	 *  `$state` scalar, where an equal primitive notifies nothing. */
	onDraft: (pct: number | null) => void;
	now?: () => number;
	setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
	clearTimeoutFn?: (handle: TimerHandle) => void;
}

export interface GuideSend {
	/** The value moved under the finger, or one keyboard step. Throttled, with a trailing send. */
	input(pct: number): void;
	/** The gesture ended here. Always sends, and cancels the trailing send it supersedes — the value the guest
	 *  stopped on is the one that matters, so it may not be the one the throttle drops. */
	commit(pct: number): void;
	/** The song changed: drop a trailing send still waiting on the throttle, which belonged to the last song. */
	cancel(): void;
}

/** One command per window at most. The guide level is a continuous drag against a room-wide broadcast, so an
 *  unthrottled drag puts one frame per pointermove on every phone and the TV. */
export const GUIDE_SEND_THROTTLE_MS = 120;

export function createGuideSend(opt: GuideSendOptions): GuideSend {
	const now = opt.now ?? (() => Date.now());
	/* WRAPPED, never a bare `setTimeout` reference: stored and called as a plain function, the browser's own
	   throws "Illegal invocation". `WsClient` carries the measured account of that. */
	const setTimer = opt.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	const clearTimer = opt.clearTimeoutFn ?? ((handle: TimerHandle) => clearTimeout(handle as never));

	/* NEGATIVE INFINITY, not 0, so the FIRST input always clears the window whatever the clock reads. Seeded at
	   0 this is only true for a wall clock; a test injecting a clock that starts near zero would see its first
	   input scheduled instead of sent, which is the throttle mis-firing in the one case nothing is pending. */
	let lastSentAt = Number.NEGATIVE_INFINITY;
	/** Did the last send reach the wire? The draft may only advance while this holds — see `input`. */
	let landed = true;
	let pending: TimerHandle | null = null;

	function fire(pct: number): void {
		lastSentAt = now();
		landed = opt.send(pct);
		opt.onDraft(landed ? pct : null);
	}

	function cancelTrailing(): void {
		if (pending === null) return;
		clearTimer(pending);
		pending = null;
	}

	return {
		input(pct: number): void {
			const since = now() - lastSentAt;
			/* ANY NEW INPUT SUPERSEDES THE TRAILING SEND, including one taken on the immediate branch below — which
			   is not merely tidy. The timer is armed for the remainder of the window, so the only way it is still
			   pending once the window has passed is a main thread that missed its deadline (a long task, a
			   backgrounded tab), and a drag is exactly where that happens. Left armed, it would land AFTER the
			   immediate send and set the guide back to a level the guest has already moved off. */
			cancelTrailing();
			if (since >= GUIDE_SEND_THROTTLE_MS) {
				fire(pct);
				return;
			}
			/* Inside the window nothing is sent, so the draft is the only thing that can track the finger — and it
			   may only do so while the wire is known good. With the socket down the DRAFT therefore does not advance,
			   and the readout, which reads `guideDraft ?? guideServerPct`, shows the room's level throughout.
			   THAT IS AS FAR AS THIS MODULE REACHES, and claiming more here was a false comment worth recording: it
			   used to read "the control therefore does not move at all", which is a property of the whole control and
			   not of a draft — and it was measured FALSE. bits-ui keeps its own copy of the slider's value, so the
			   thumb, the filled range and `aria-valuenow` advanced on the refused command anyway (0 → 95 offline
			   against a room at 0%) and survived the reconnect, while the readout held. The rest of the promise is
			   `GuidingTrack.svelte`, which binds that value to a getter over the caller's `pct` so there is no second
			   copy left to diverge; its header carries the measurements. Both halves are load-bearing and
			   tests/unit/lib/player-command-drop.test.ts pins each, because either one alone restores the defect.
			   The ± keycaps need the draft half ALONE, and that is why the analogy does not carry further: they render
			   the number themselves and own no widget holding a value of its own. It is also why they were honest by
			   accident before any draft existed — they read the server value and so simply could not move. */
			if (landed) opt.onDraft(pct);
			pending = setTimer(() => {
				pending = null;
				fire(pct);
			}, GUIDE_SEND_THROTTLE_MS - since);
		},
		commit(pct: number): void {
			cancelTrailing();
			fire(pct);
		},
		cancel: cancelTrailing
	};
}
