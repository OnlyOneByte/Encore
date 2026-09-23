// The PROCESS GATES — the one declaration of what "ready to sing" means. Adding a processing step is one
// entry in `GATES` and nothing else, because every consumer asks `readyToSing` / `pendingGates`.
//
// TWO QUESTIONS THAT MUST KEEP DIFFERENT NAMES, because conflating them makes a finished song re-process
// from scratch:
//   playbackRef / hasInstrumental → "what file do I load"   (the TV player, the re-process check)
//   readyToSing                   → "is this song finished"  (rotation, the library, the Ready group)
//
// See docs/SERVER.md#song-profile-and-readiness.

import type { Media } from '../core/types';
import type { MediaStage } from '../core/events';

export interface ProcessGate {
	/** Stable id — matches the job type that satisfies it, so a log line reads the same on both sides. */
	readonly id: 'stems' | 'lyrics';
	/**
	 * The stop on `MEDIA_STAGES` a song sits at while this step is outstanding. It lives HERE and NOT in a
	 * lookup table beside its consumer, because a separate gate-id → stage map means a new gate must be
	 * registered in two places and the second one is the one nobody thinks to look for.
	 */
	readonly stage: MediaStage;
	/**
	 * Is this step FINISHED for this song? A PREDICATE rather than a status check, because "done" is not
	 * uniform: separation needs the status AND the artifact key (written by separate steps, and a status
	 * without a ref hands the player an empty source), while alignment is done as soon as it has RUN.
	 */
	readonly done: (m: Media) => boolean;
	/**
	 * Does singing WAIT for this step? Every gate is required today; the flag exists so a future
	 * enrichment can be declared in this same table, visible to the progress UI without blocking a turn,
	 * rather than bolted on outside the model and entangled with playability.
	 */
	readonly required: boolean;
}

/**
 * The pipeline, in order. THE place to add a step. A step that does not gate singing and has no enqueue
 * path is deliberately absent rather than declared non-required.
 */
export const GATES: readonly ProcessGate[] = [
	{
		id: 'stems',
		stage: 'separating',
		// Status AND artifact, both from the one stems job. The song profile is deliberately NOT required
		// here: the worker writes it unconditionally beside the ready mark, so `stemStatus === 'ready'`
		// already proves it ran, while REQUIRING it makes every song processed before profiles existed
		// unsingable forever AND un-reprocessable, since the re-process check reads `hasInstrumental` rather
		// than this gate. A wire-shape regression that stops the profile arriving is caught loudly by the
		// parity test instead of silently by this gate.
		done: (m) => m.stemStatus === 'ready' && !!m.instrumentalRef,
		required: true
	},
	{
		id: 'lyrics',
		stage: 'aligning',
		// RAN, not "produced words": `lyricsRef` is absent for a genuine instrumental and that song is still
		// finished. Media predating this gate carry no `lyricsStatus`, so an existing artifact counts as
		// done and an upgrade cannot silently make a library unsingable.
		done: (m) => m.lyricsStatus === 'ready' || !!m.lyricsRef,
		required: true
	}
] as const;

/** Is this song finished — every required step done? The single gate for rotation, the library list and
 *  the phone's Ready group. */
export function readyToSing(m: Media): boolean {
	return GATES.every((g) => !g.required || g.done(m));
}

/** The required steps still outstanding, in pipeline order. Empty ⇔ `readyToSing`. */
export function pendingGates(m: Media): ProcessGate[] {
	return GATES.filter((g) => g.required && !g.done(m));
}

/**
 * Is a process in flight — not finished, but the pipeline has started?
 *
 * GATE-DRIVEN and never a single hardcoded status, because a single status only ever sees the FIRST step: a
 * song mid-align is past stems and not finished, so it matches neither "ready" nor "queued" and falls
 * through to unacquired, offering a Sing button on an already-separated song. Reading the gate table means
 * a future gate cannot reopen that hole, since a song between two gates stays "processing" automatically.
 */
export function isProcessing(m: Media): boolean {
	if (readyToSing(m)) return false;
	// Started = some gate already reports done, OR the first step is actively enqueued. Only a song with
	// nothing started is unacquired.
	return GATES.some((g) => g.done(m)) || m.stemStatus === 'queued';
}
