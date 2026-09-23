import { MEDIA_STAGES, mediaStagePosition, type MediaStatus } from '$lib/contract/core/events';

/**
 * Overall process completion for the processing bar — NOT the current step's own progress, which fills the
 * whole bar at the end of every step while later milestones have not started.
 *
 * TWO INVARIANTS, both falling out of the cumulative band table rather than being approximated: the bar
 * reaches 100 IFF the status is `ready`, and it never moves backward across a stage change.
 *
 * The bands are WEIGHTED, not equal: separation dominates wall-clock while queueing and alignment are
 * near-instant, so equal bands make the bar sprint and then crawl — lying in the opposite direction from the
 * defect it replaces. A status off the line reports 0, and a stalled bar there is honest.
 */

// Cumulative fraction completed AT THE END of each in-flight stage. The last in-flight stage tops out just
// below 100, so only `ready` can reach it. Keyed on the shared stage vocabulary, so this cannot silently
// disagree with the chip strip's order.
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
 * @param status the song's current process stage
 * @param stepPct the worker's own 0–100 for that stage (clamped)
 */
export function overallProcessPct(status: MediaStatus, stepPct: number): number {
	if (status === 'ready') return 100;
	const pos = mediaStagePosition(status);
	if (pos < 0) return 0; // failed / canceled — off the line

	// This stage's band runs from the previous stage's end to its own, filled linearly, so the bar advances
	// smoothly and can never exceed the band top.
	const bandStart = pos === 0 ? 0 : BAND_END[MEDIA_STAGES[pos - 1]!];
	const bandEnd = BAND_END[status];
	// A non-finite step pct would poison the transform and the readout with NaN, so it reads as 0 and the bar
	// shows the band floor rather than silently keeping its previous fill.
	const p = (Number.isFinite(stepPct) ? Math.max(0, Math.min(100, stepPct)) : 0) / 100;
	return bandStart + (bandEnd - bandStart) * p;
}
