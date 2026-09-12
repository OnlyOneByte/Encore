// Lyrics backfill — give ALREADY-COOKED songs lyrics.
//
// WHY THIS EXISTS. `followUps` only fires when a stems job COMPLETES, so lyrics exist exclusively for
// songs cooked after the align-enqueue fix landed. Measured on the owner's live library: 13 cooked
// songs, 3 with lyrics — 10 that could never get them, since re-cooking is the only other path and
// nobody re-cooks a working song. The multi-candidate "upgrade path" had no entry point without this.
//
// PURE selector: takes the catalog and returns the media ids that need an align job, so the policy is
// testable without a DB, a worker, or a clock.

import type { Media } from '$lib/contract';
import { hasUsableTiming } from '$lib/contract';

/**
 * Priority for backfilled align jobs — the largest possible number, i.e. dead last. Priority mirrors
 * the soonest rotationSeq that needs the media (lower = sooner), so a live cook always outranks the
 * backfill queue. Sharing the value with make-karaoke's NO_QUEUE_PRIORITY is intentional: both mean
 * "nobody is waiting on this".
 */
export const BACKFILL_PRIORITY = Number.MAX_SAFE_INTEGER;

/**
 * Cooked songs that have no WORD-timed lyrics yet, worst-off first.
 *
 * Only cooked songs (`file` + stems `ready`): an align job needs the vocals stem for its ASR tier;
 * an uncooked song gets lyrics through the normal chain when someone cooks it. "Needs align" includes
 * a song with only LINE-level lyrics — line sync is the floor, word timings the goal, and re-aligning
 * from retained audio costs no download. A song already at word timings is skipped: re-running would
 * spend an ML pass to produce something `pickBestLyrics` ranks no higher.
 */
export function needsLyricsBackfill(catalog: Iterable<Media>): string[] {
	const out: string[] = [];
	for (const m of catalog) {
		if (m.stemStatus !== 'ready') continue;
		const best = (m.lyricsCandidates ?? []).filter(hasUsableTiming);
		if (best.some((c) => c.timing === 'word')) continue; // already at the ideal tier
		// A pre-candidate artifact (schema-1) counts as unknown timing: it may well be word-timed, and
		// re-aligning it would be wasted work, so a bare lyricsRef with no candidates is left alone.
		if (!m.lyricsCandidates?.length && m.lyricsRef) continue;
		out.push(m.id);
	}
	return out;
}
