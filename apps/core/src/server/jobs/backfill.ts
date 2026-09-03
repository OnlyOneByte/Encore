// Lyrics backfill (B-3-C7) — give ALREADY-COOKED songs lyrics.
//
// WHY THIS EXISTS. `followUps` only fires when a stems job COMPLETES, so lyrics exist exclusively for
// songs cooked after B-3-C1 landed. Measured on the owner's live library: 13 cooked songs, 3 with
// lyrics — 10 that could never get them, because re-cooking is the only path and nobody is going to
// re-cook a working song. The whole multi-candidate design was justified by an "upgrade path"; without
// this, that path had no entry point.
//
// PURE selector: takes the catalog and returns the media ids that need an align job, so the policy is
// testable without a DB, a worker, or a clock.

import type { Media } from '@encore/shared';
import { hasUsableTiming } from '@encore/shared';

/**
 * Priority for backfilled align jobs — the largest possible number, i.e. dead last.
 *
 * Job priority mirrors the soonest rotationSeq that needs the media (lower = sooner), so a live cook
 * for a singer waiting to sing always outranks the entire backfill queue. Sharing the value with
 * make-karaoke's NO_QUEUE_PRIORITY is intentional: both mean "nobody is waiting on this".
 */
export const BACKFILL_PRIORITY = Number.MAX_SAFE_INTEGER;

/**
 * Cooked songs that have no WORD-timed lyrics yet, worst-off first.
 *
 * Only cooked songs (`file` + stems `ready`): an align job needs the vocals stem for its ASR tier, and
 * an uncooked song has none — it will get lyrics through the normal chain when someone cooks it.
 *
 * "Needs align" deliberately includes a song that already has LINE-level lyrics: line sync is the floor,
 * word timings are the goal, and re-aligning from the retained audio costs no download. A song that
 * already has word timings from any source is skipped — re-running would spend an ML pass to produce
 * something `pickBestLyrics` would rank no higher.
 */
export function needsLyricsBackfill(catalog: Iterable<Media>): string[] {
	const out: string[] = [];
	for (const m of catalog) {
		if (m.playMode !== 'file' || m.stemStatus !== 'ready') continue;
		const best = (m.lyricsCandidates ?? []).filter(hasUsableTiming);
		if (best.some((c) => c.timing === 'word')) continue; // already at the ideal tier
		// A pre-candidate artifact (schema-1) counts as unknown timing: it may well be word-timed, and
		// re-aligning it would be wasted work, so a bare lyricsRef with no candidates is left alone.
		if (!m.lyricsCandidates?.length && m.lyricsRef) continue;
		out.push(m.id);
	}
	return out;
}
