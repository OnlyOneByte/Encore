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
