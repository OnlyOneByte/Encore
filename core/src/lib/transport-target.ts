// Which song the strip's skip and restart NAME. Pure, so a bun test can decide it. See routes/+layout.svelte.
//
// The server drops a transport command naming a song that is no longer current (BE-04). That alone only protects a
// tap that was in flight when the song changed: on a LAN the second phone redraws to the NEXT song within ~30 ms of
// the first skip, and a second tap after that named the next song and took the next singer's turn too (review r2,
// 974-M2: two real taps 40-80 ms apart took two songs). So for a short settle window after the song on the strip
// changes, the transport keeps naming the song that was there before: the server drops the tap and the phone says
// "That song already ended." A deliberate skip of the new song inside that window needs one more tap.

/** Long enough for two people reaching for skip at the end of a bad song; short of the TV's 2.5 s intro card. */
export const SETTLE_MS = 1000;

export interface TransportTarget {
	/** The entry the strip shows now. */
	shown: string | null;
	/** The entry it showed before the last change, and when that change was seen. */
	previous: string | null;
	changedAt: number;
}

export const NO_TARGET: TransportTarget = { shown: null, previous: null, changedAt: Number.NEGATIVE_INFINITY };

/** Fold the entry the strip shows now into the state. Same entry: the state is returned unchanged. */
export function observeShown(t: TransportTarget, shown: string | null, nowMs: number): TransportTarget {
	return shown === t.shown ? t : { shown, previous: t.shown, changedAt: nowMs };
}

/** The entry a skip or restart tapped at `nowMs` names. Inside the settle window after a change from one song to
 *  another, that is the song before; a song that started from an idle room has no "before" and names itself. */
export function transportTarget(t: TransportTarget, nowMs: number): string | null {
	return t.previous !== null && nowMs - t.changedAt < SETTLE_MS ? t.previous : t.shown;
}
