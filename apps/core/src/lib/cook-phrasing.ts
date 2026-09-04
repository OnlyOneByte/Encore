// The ONE place the "cook" is described to a guest. Two surfaces show the same underlying worker
// states — SongRow (the search result morphing in place) and ProcessingCard (the live progress card)
// — and they had drifted into two vocabularies for one thing: the card said "Separating vocals…" /
// "Aligning lyrics…" with chips "Separating" / "Lyrics", while the row said "Making karaoke…" /
// "Karaoke ready". A first-time guest called the card's wording "written for the developer, not the
// guest at a party": separating vocals is what the WORKER does, and "vocals"/"instrumental" is the
// musician's word a guest found confusing. What a guest is waiting for is a karaoke track.
//
// So both surfaces call THIS, and there is no third vocabulary to drift into. The percentage and ETA
// (the honest part of the old copy, per the same review) stay with the caller; this owns only the words.
import type { MediaStatus } from '@encore/shared';

/**
 * The guest-facing stage line — the sentence under the title while a song cooks. `pct`/`etaSec` are
 * appended when present; a caller that shows those separately can omit them.
 */
export function cookStageLabel(status: MediaStatus, opts: { pct?: number; etaSec?: number } = {}): string {
	if (status === 'ready') return 'Karaoke ready';
	if (status === 'failed') return "Couldn't make karaoke";
	const eta = opts.etaSec && opts.etaSec > 0 ? ` · ~${Math.max(1, Math.round(opts.etaSec / 60))} min left` : '';
	const pct = typeof opts.pct === 'number' ? ` ${opts.pct}%` : '';
	return `Making karaoke…${pct}${eta}`;
}

/**
 * The short label for a single stage chip in ProcessingCard's progress track. Same guest vocabulary
 * as the stage line: the worker's step names ("Separating", "Lyrics") become plain-English milestones
 * on the way to a karaoke track.
 */
export function cookStageChipLabel(status: MediaStatus): string {
	switch (status) {
		case 'queued':
			return 'Queued';
		case 'downloading':
			return 'Fetched';
		case 'separating':
			return 'Making karaoke';
		case 'aligning':
			return 'Adding lyrics';
		case 'ready':
			return 'Ready';
		case 'failed':
			return 'Failed';
	}
}
