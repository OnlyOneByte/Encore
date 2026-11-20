import { expect, test } from 'bun:test';
import { createGuideSend, GUIDE_SEND_THROTTLE_MS } from '$lib/guide-send';

/*
 * The guiding-track send: the throttle's trailing edge, and the rule that a DROPPED command may not leave a local
 * draft standing. The second of those is the regression this whole wave is about — `/queue`'s ± keycaps shipped it
 * once (a keycap showing a shift the server never heard, stuck until a reload) and the slider is the other control
 * that holds an optimistic value.
 *
 * Driven here rather than in a browser because it is arithmetic over a clock and a boolean: a Chromium spec can
 * see the thumb, but it cannot see WHICH of three drag positions the trailing send carried, and the component-mount
 * harness that would sit between them is gone (bunfig.toml records why). The route's own half — the `$state` draft
 * and the effect that drops it when the room agrees — is a source guard in player-command-drop.test.ts.
 */

/** A rig with a hand-cranked clock and exactly one timer slot, which is all `createGuideSend` ever arms. */
function rig() {
	/* STARTS AT ZERO deliberately. A rig whose clock starts past one throttle window cannot tell a `-Infinity`
	   seed from a `0` one, so the first-input test below would pass against either. */
	let nowMs = 0;
	let wireUp = true;
	const sent: number[] = [];
	const drafts: (number | null)[] = [];
	let timer: { fn: () => void; ms: number } | null = null;

	const guide = createGuideSend({
		send: (pct) => {
			sent.push(pct);
			return wireUp;
		},
		onDraft: (pct) => drafts.push(pct),
		now: () => nowMs,
		setTimeoutFn: (fn, ms) => {
			timer = { fn, ms };
			return timer;
		},
		clearTimeoutFn: () => {
			timer = null;
		}
	});

	return {
		guide,
		sent,
		drafts,
		advance: (ms: number) => {
			nowMs += ms;
		},
		cutWire: () => {
			wireUp = false;
		},
		pending: () => timer,
		/** Run the armed trailing send, as the real timer would. */
		runTrailing: () => {
			const armed = timer;
			if (!armed) throw new Error('no trailing send armed');
			timer = null;
			armed.fn();
		}
	};
}

test('the first input sends immediately, whatever the clock reads', () => {
	/* The window is seeded at -Infinity rather than 0 for this: with a 0 seed the claim only holds for a wall
	   clock, and a clock starting near zero would see the very first input scheduled instead of sent. */
	const r = rig();
	r.guide.input(40);
	expect(r.sent).toEqual([40]);
	expect(r.drafts).toEqual([40]);
	expect(r.pending()).toBeNull();
});

test('a dropped command clears the draft instead of leaving the slider at a level the room has not got', () => {
	// THE WHOLE POINT. A player command is not resent on resync, so there is nothing to be optimistic about.
	const r = rig();
	r.cutWire();
	r.guide.input(40);
	expect(r.sent).toEqual([40]);
	expect(r.drafts).toEqual([null]);
});

test('inside the window nothing is sent, the draft tracks the finger, and the trailing send carries the LAST value', () => {
	/* Without the trailing edge the position a fast drag ENDS on is the one that gets dropped, which leaves the
	   guide at a level the guest did not choose — the reason the deleted sheet had it and this kept it. */
	const r = rig();
	r.guide.input(40);
	r.advance(20);
	r.guide.input(55);
	r.advance(20);
	r.guide.input(70);

	expect(r.sent).toEqual([40]);
	expect(r.drafts).toEqual([40, 55, 70]);
	// Re-armed from the LATEST input's position in the window, not the first: 120 - 40 elapsed.
	expect(r.pending()?.ms).toBe(GUIDE_SEND_THROTTLE_MS - 40);

	r.advance(GUIDE_SEND_THROTTLE_MS - 40);
	r.runTrailing();
	expect(r.sent).toEqual([40, 70]);
	expect(r.drafts).toEqual([40, 55, 70, 70]);
});

test('with the wire known bad the draft does not advance inside the window either', () => {
	/* The ± keycaps' honesty, applied to the slider: offline the control simply does not move, which is what it
	   did by accident before a draft existed. The repeated nulls are not filtered on purpose — the route writes
	   them into a `$state` scalar, where an equal primitive notifies nothing. */
	const r = rig();
	r.cutWire();
	r.guide.input(40);
	r.advance(20);
	r.guide.input(55);
	r.advance(20);
	r.guide.input(70);
	expect(r.drafts).toEqual([null]);

	r.advance(GUIDE_SEND_THROTTLE_MS - 40);
	r.runTrailing();
	expect(r.sent).toEqual([40, 70]);
	expect(r.drafts).toEqual([null, null]);
});

test('a commit supersedes the trailing send, and a LANDED commit leaves the draft standing', () => {
	/* The release may not fall through to the server echo. The old drag-scoped flag did, so a commit that landed
	   still showed the OLD level for one round trip — the spring-back docs/UI-REVIEW.md finding C describes,
	   whose dropped half this file's second test covers. Only the room agreeing clears the draft now, and that
	   arm lives in the route's effect. */
	const r = rig();
	r.guide.input(40);
	r.advance(20);
	r.guide.input(55);
	expect(r.pending()).not.toBeNull();

	r.guide.commit(60);
	expect(r.pending()).toBeNull();
	expect(r.sent).toEqual([40, 60]);
	expect(r.drafts.at(-1)).toBe(60);
});

test('a dropped commit clears the draft', () => {
	const r = rig();
	r.guide.input(40);
	r.cutWire();
	r.advance(GUIDE_SEND_THROTTLE_MS);
	r.guide.commit(60);
	expect(r.sent).toEqual([40, 60]);
	expect(r.drafts).toEqual([40, null]);
});

test('an immediate send cancels a trailing one the clock has already outrun', () => {
	/* The timer is armed for the remainder of the window, so it can only still be pending once the window has
	   passed if the main thread missed its deadline — a long task, a backgrounded tab — which a drag is exactly
	   where to expect. Left armed it lands AFTER the newer send and sets the guide back to a level the guest has
	   moved off. The original drag code armed it and never cancelled on this branch. */
	const r = rig();
	r.guide.input(40);
	r.advance(20);
	r.guide.input(55);
	expect(r.pending()).not.toBeNull();

	r.advance(GUIDE_SEND_THROTTLE_MS);
	r.guide.input(70);
	expect(r.sent).toEqual([40, 70]);
	expect(r.pending()).toBeNull();
});

test('a commit ignores the throttle', () => {
	// The value the guest stopped on is the one that matters; a commit coalesced into a window is a lost write.
	const r = rig();
	r.guide.input(40);
	r.advance(1);
	r.guide.commit(41);
	expect(r.sent).toEqual([40, 41]);
});

test('cancel drops the trailing send a song change left behind, and sends nothing itself', () => {
	// The route calls it when the song on the card changes: a trailing send armed on the last song must not fire.
	const r = rig();
	r.guide.input(40);
	r.advance(20);
	r.guide.input(70);
	expect(r.pending()).not.toBeNull();
	r.guide.cancel();
	expect(r.pending()).toBeNull();
	expect(r.sent).toEqual([40]);
});
