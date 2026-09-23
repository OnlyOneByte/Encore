// Gives already-processed songs lyrics. `followUps` only enqueues align on stems completion, so a song
// processed before that chaining existed has no other path to lyrics — re-processing a working song is
// not one. Pure selector (catalog in, ids out) so the policy is testable without a DB, worker, or clock.

import type { Media } from '../../contract';
import { hasUsableTiming } from '../../contract';

/** Lower priority always wins (soonest rotationSeq); MAX_SAFE_INTEGER means dead last, and sharing
 *  this value with process's NO_QUEUE_PRIORITY is deliberate — both mean "nobody is waiting on this". */
export const BACKFILL_PRIORITY = Number.MAX_SAFE_INTEGER;

/** Processed (stems-ready) songs missing word-level lyrics timing, including line-only candidates —
 *  word timing is the goal and re-aligning from retained audio is cheap, so only word-timed is skipped. */
export function needsLyricsBackfill(catalog: Iterable<Media>): string[] {
	const out: string[] = [];
	for (const m of catalog) {
		if (m.stemStatus !== 'ready') continue;
		const best = (m.lyricsCandidates ?? []).filter(hasUsableTiming);
		if (best.some((c) => c.timing === 'word')) continue;
		// A bare lyricsRef with no candidates predates the candidates schema and may already be word-timed;
		// treat it as unknown rather than re-aligning it for nothing.
		if (!m.lyricsCandidates?.length && m.lyricsRef) continue;
		out.push(m.id);
	}
	return out;
}
