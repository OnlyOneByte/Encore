// The ONE place the "process" is described to a guest. Both SongRow and ProcessingCard call this, so there is no
// second vocabulary to drift into. The percentage and ETA stay with the caller; this owns only the words, in the
// guest's terms — what a guest waits for is a karaoke track, not "separating vocals".
import type { MediaStatus } from '$lib/contract';

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
export const STALLED_TURN_LABEL = 'Karaoke hasn’t started — the rotation skips this turn until it does';
