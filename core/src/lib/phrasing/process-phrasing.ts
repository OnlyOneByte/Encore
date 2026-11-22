// The ONE place the "process" is described to a guest. Both SongRow and ProcessingCard call this, so there is no
// second vocabulary to drift into. The figures come from the caller; this owns only the words, in the guest's
// terms — what a guest waits for is a karaoke track, not "separating vocals".
import type { MediaStatus } from '$lib/contract';
import { minutesLeft } from '$lib/on-deck';
import type { WaitingTurns } from '$lib/readiness';

/** The guest-facing stage line — the sentence under the title while a song processes. `pct` is appended when present;
 * a caller that shows it separately can omit it. */
export function processStageLabel(status: MediaStatus, opts: { pct?: number } = {}): string {
	if (status === 'ready') return 'Karaoke ready';
	if (status === 'failed') return "Couldn't make karaoke";
	// A cancel is not a failure and gets no line: the song went back to un-processed and the row shows the
	// Sing button again, so saying anything here would narrate the guest's own removal back at them.
	if (status === 'canceled') return '';
	const pct = typeof opts.pct === 'number' ? ` ${opts.pct}%` : '';
	return `Making karaoke…${pct}`;
}

/** The readout when the song is well past its estimate: one honest sentence instead of a time, and no figure. */
export const OVERDUE_LABEL = 'Taking longer than usual';

/** The figures beside that line: "64% · ~2 min", either half alone, or nothing. The percentage only once the
 * worker has reported a real one for this step (`stepPct > 0`): an engine with no figure (the in-process zoo)
 * keeps the stage floor on the bar but says only the time. The time in the on-deck card's words, no time when
 * there is no history to base one on, and `OVERDUE_LABEL` alone when the estimate has been overrun (etaSec < 0). */
export function processReadout(overallPct: number, stepPct: number, etaSec?: number | null): string {
	if (etaSec != null && etaSec < 0) return OVERDUE_LABEL;
	const time = etaSec == null ? null : minutesLeft(etaSec);
	return [stepPct > 0 ? `${Math.round(overallPct)}%` : null, time].filter(Boolean).join(' · ');
}

/** A TURN NOBODY IS MAKING KARAOKE FOR — the stalled queue card's line.
 *
 * A SIBLING EXPORT RATHER THAN A `MediaStatus` ARM, deliberately: `contract/process/readiness.ts` records why
 * there is no such status ("`failed` is deliberately NOT a member… a dead process settles the status back to
 * un-processed"), and a stalled turn is precisely the state where NO status exists to describe. So
 * `processStageLabel` keeps taking only a `MediaStatus`.
 *
 * IT STATES THE TURN'S FATE, NOT AN ATTEMPT'S HISTORY, and that is the whole reason it is not
 * `processStageLabel('failed')`. "Couldn't make karaoke" asserts that something ran and died; of the 50 media
 * stranded in the owner's library copy, 3 have no `jobs` row and no `job_attempts` row at all, so nothing ever ran
 * for them — and for the other 47 the honest thing a guest needs is not the autopsy but what happens to their
 * turn. PRESENT TENSE, because it is equally true of a turn that has been dead for a week and of the
 * one-round-trip window before another phone's process broadcast arrives.
 *
 * THE REMEDY IS ON THE CONTROL, not in the sentence: the card's retry button carries "you keep your turn", which
 * a sentence naming a button would duplicate and then outlive. */
export const STALLED_TURN_LABEL = "Can't make this one right now";

/** The Sing tab's heading over the songs a search found that are not ready: a claim about what follows, so
 * "Making karaoke…" only while some row really is being made, and otherwise the stalled line, plural over a group.
 * `making` is one flag per row: in flight AND not condemned by the server. */
export function processingGroupHeading(making: boolean[]): string {
	if (making.some(Boolean)) return processStageLabel('queued');
	return making.length === 1 ? STALLED_TURN_LABEL : "Can't make these right now";
}

/** WHAT THE ROOM IS WAITING ON when nothing queued can play and nothing is being made: the TV lobby's headline and
 * line, and the phone strip's headline. One source, so the TV and every phone say the same sentence. `null` while
 * something is being made, or nothing is stuck — the caller's ordinary copy is then the true one.
 * NO MAKER OUTRANKS A FAILURE, because it is the one that also stops the NEXT song: a guest who picks another
 * unprocessed song hits the same wall, so the honest move is a ready one.
 * ANY OTHER STUCK TURN NAMES BOTH WAYS OUT, as its card does ("Couldn't make karaoke · Try again · Pick another"):
 * once a maker is here, a song that died for want of one is made by a Try again, so "pick another" alone sent the
 * guest away from a song that now works.
 * ONE APOSTROPHE, the ASCII one, like "Couldn't make karaoke" on the card beside it. */
export function stuckTurnsLines(
	waiting: WaitingTurns,
	nameOf: (singerId: string) => string,
	me?: string | null
): { headline: string; next: string } | null {
	if (waiting.making || !waiting.stuckSingerIds.length) return null;
	if (waiting.noMaker) return { headline: "Can't make new karaoke right now", next: 'Pick a ready song on your phone' };
	const only = waiting.stuckSingerIds.length === 1 ? waiting.stuckSingerIds[0]! : null;
	if (only && only === me)
		return { headline: "Your song didn't work. Try again or pick another.", next: 'Try again or pick another' };
	if (only) {
		const name = nameOf(only);
		return { headline: `${name}'s song didn't work`, next: `${name}, try again or pick another on your phone` };
	}
	return { headline: "Those songs didn't work", next: 'Try again or pick another on your phone' };
}

/** The moment after a guest taps Try again on a card nothing is making, before the server's answer lands. */
export const RETRYING_LABEL = 'Trying again…';
