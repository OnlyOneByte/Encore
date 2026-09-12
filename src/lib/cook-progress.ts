import { MEDIA_STAGES, mediaStagePosition, type MediaStatus } from '$lib/contract';

/**
 * Overall cook completion 0–100 for the processing bar — NOT the current step's own progress.
 *
 * `ProcessingCard` scaled the whole bar by the worker's per-step `pct`, so every step that
 * reached 100% filled the bar while later milestones had not started. The fix maps that per-step pct
 * into a per-stage BAND over `MEDIA_STAGES`, so the bar reads how far through the *cook* a song is.
 *
 * The invariant the roadmap's done-when names: the bar reaches 100 **iff `status === 'ready'`**, and
 * it never moves backward across a stage change. Both fall out of a cumulative band table rather than
 * being approximated — `ready` is the only status whose band top is 100.
 *
 * Bands are weighted, not equal fifths, on purpose. Separation dominates wall-clock (~1–2 min/song on
 * CPU) while queueing and alignment are near-instant, so equal fifths would make the bar sprint to 60%
 * and then crawl — lying in the opposite direction from the bug it replaces. `queued` gets a sliver so
 * a freshly-enqueued song shows *some* motion without claiming real work has happened.
 *
 * A status off the line (`failed` / `canceled`, `mediaStagePosition` -1) has no band; it reports 0 —
 * the caller renders those with their own failed/canceled styling, and a stalled bar there is honest.
 */

// Cumulative fraction of the whole cook completed AT THE END of each in-flight stage. The last
// in-flight stage (`aligning`) tops out just below 100 so only `ready` can reach 100. Keyed on the
// shared MEDIA_STAGES vocabulary so this cannot silently disagree with the chip strip's order.
const BAND_END: Readonly<Record<MediaStatus, number>> = {
	queued: 3, // enqueued, no real work yet — a sliver of motion only
	downloading: 20, // fetch from YouTube — network-bound, quick
	separating: 90, // Demucs/stems — the ~1–2 min the room actually waits on
	aligning: 99, // WhisperX/lyrics — fast; leaves the last point for `ready`
	ready: 100, // terminal: the ONLY status whose band reaches 100
	failed: 0,
	canceled: 0
};

/**
 * @param status the song's current cook stage
 * @param stepPct the worker's own 0–100 for that stage (clamped)
 */
export function overallCookPct(status: MediaStatus, stepPct: number): number {
	if (status === 'ready') return 100;
	const pos = mediaStagePosition(status);
	if (pos < 0) return 0; // failed / canceled — off the line

	// The band for THIS stage runs from the previous stage's end to this stage's end. The intra-step
	// pct fills that band linearly, so the bar advances smoothly and can never exceed the band top.
	const bandStart = pos === 0 ? 0 : BAND_END[MEDIA_STAGES[pos - 1]!];
	const bandEnd = BAND_END[status];
	// A non-finite stepPct (NaN/Infinity) would poison scaleX and the readout with NaN; treat it as 0
	// so the bar shows the band floor rather than silently keeping its previous fill.
	const p = (Number.isFinite(stepPct) ? Math.max(0, Math.min(100, stepPct)) : 0) / 100;
	return bandStart + (bandEnd - bandStart) * p;
}
