// WHAT A LEAVE WOULD COST, in words. Pure and DOM-free, because the sentence IS the statement the guest acts on:
// leaving clears the cookie and forgets the singer, so there is no undo and the price has to be named before it is paid.
//
// IT IS A MODULE RATHER THAN AN INLINE $derived so the UNKNOWN arm is assertable — `bun test` mounts no components —
// and the unknown arm is the whole reason this exists. The confirm used to read `leaveCost?.queuedCount ?? 0`, so a
// cost that had not answered yet rendered as a confident zero: "You have no songs queued" over three queued songs,
// with "Yes, leave" already tappable. On a failed GET that claim was permanent rather than a flicker, and because
// `role="alertdialog"` announces its description AT MOUNT and the description is not a live region, the screen-reader
// path heard the zero on every single open — at any latency — and never heard the correction.

/** Shape of GET /api/leave's success body: what a leave would remove, counted by the server. */
export interface LeaveCost {
	/** How many entries `removableOnLeave` would delete. It EXCLUDES the playing entry, which is why `hasPlaying` is
	 * a separate fact rather than part of this number. */
	queuedCount: number;
	hasPlaying: boolean;
}

/**
 * COUNTS, NOT ADJECTIVES when the count is known; no number at all when it is not. `null` means the cost fetch has
 * not answered — in flight, or dead — and it is NOT zero.
 *
 * The unknown arm also drops the `hasPlaying` clause rather than guessing at it, so the sentence asserts nothing that
 * the arriving number could contradict: "any songs you have queued" is true whether the answer turns out to be 0, 1
 * or 12, and it says nothing about the song on screen either way. That is what keeps the fix latency-independent —
 * the alternative, disabling the confirm until the cost lands, would trap a guest whose GET never answers inside the
 * room they are trying to leave.
 */
export function leaveCostSentence(cost: LeaveCost | null): string {
	if (cost === null) return "Any songs you have queued will be removed, and you'll need to rejoin to sing again.";

	const n = cost.queuedCount;
	const songs =
		n === 0
			? 'You have no songs queued'
			: n === 1
				? 'Your 1 queued song will be removed'
				: `Your ${n} queued songs will be removed`;
	const playing = cost.hasPlaying ? ' The song on screen now will finish.' : '';
	return `${songs}, and you'll need to rejoin to sing again.${playing}`;
}
