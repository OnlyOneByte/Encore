// The ONE place the "process" is described to a guest. Two surfaces show the same underlying worker
// states — SongRow (the search result morphing in place) and ProcessingCard (the live progress card)
// — and they had drifted into two vocabularies for one thing: the card said "Separating vocals…" /
// "Aligning lyrics…" with chips "Separating" / "Lyrics", while the row said "Making karaoke…" /
// "Karaoke ready". A first-time guest called the card's wording "written for the developer, not the
// guest at a party": separating vocals is what the WORKER does, and "vocals"/"instrumental" is the
// musician's word a guest found confusing. What a guest is waiting for is a karaoke track.
//
// So both surfaces call THIS, and there is no third vocabulary to drift into. The percentage and ETA
// (the honest part of the old copy, per the same review) stay with the caller; this owns only the words.
import type { MediaStatus } from '$lib/contract';

/**
 * The guest-facing stage line — the sentence under the title while a song processes. `pct` is
 * appended when present; a caller that shows it separately can omit it.
 */
export function processStageLabel(status: MediaStatus, opts: { pct?: number } = {}): string {
	if (status === 'ready') return 'Karaoke ready';
	if (status === 'failed') return "Couldn't make karaoke";
	// A cancel is not a failure and gets no line: the song went back to un-processed and the row shows the
	// Sing button again, so saying anything here would narrate the guest's own removal back at them.
	if (status === 'canceled') return '';
	const pct = typeof opts.pct === 'number' ? ` ${opts.pct}%` : '';
	return `Making karaoke…${pct}`;
}
