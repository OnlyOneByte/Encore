// The one declaration of what "ready to sing" means: adding a step is one entry in `GATES` and nothing
// else. TWO QUESTIONS MUST KEEP DIFFERENT NAMES, or a finished song re-processes from scratch —
// `playbackRef`/`hasInstrumental` answer "what file do I load", `readyToSing` answers "is this finished".
// See docs/SERVER.md#song-profile-and-readiness.

import type { Media } from '../core/types';
import type { MediaStage } from '../core/events';

export interface ProcessGate {
	/** Stable id — matches the job type that satisfies it, so a log line reads the same on both sides. */
	readonly id: 'stems' | 'lyrics';
	/** HERE and not in a lookup table beside its consumer: a separate gate-id → stage map means a new gate
	 *  must be registered in two places, and the second is the one nobody thinks to look for. */
	readonly stage: MediaStage;
	/** A PREDICATE, not a status check, because "done" is not uniform: separation needs the status AND the
	 *  artifact key, while alignment is done as soon as it has RUN. */
	readonly done: (m: Media) => boolean;
	/** Every gate is required today; the flag exists so a future enrichment can be declared in this same
	 *  table, visible to the progress UI without blocking a turn. */
	readonly required: boolean;
}

/** The pipeline, in order. THE place to add a step. A step with no enqueue path is deliberately absent
 *  rather than declared non-required. */
export const GATES: readonly ProcessGate[] = [
	{
		id: 'stems',
		stage: 'separating',
		// Status AND artifact, both from the one stems job. The song profile is deliberately NOT required:
		// requiring it makes every song processed before profiles existed unsingable AND un-reprocessable,
		// since the re-process check reads `hasInstrumental` rather than this gate.
		done: (m) => m.stemStatus === 'ready' && !!m.instrumentalRef,
		required: true
	},
	{
		id: 'lyrics',
		stage: 'aligning',
		// RAN, not "produced words": a genuine instrumental has no `lyricsRef` and is still finished. A row
		// predating this gate carries no `lyricsStatus`, so an existing artifact counts as done.
		done: (m) => m.lyricsStatus === 'ready' || !!m.lyricsRef,
		required: true
	}
] as const;

/** The single gate for rotation, the library list and the phone's Ready group. */
export function readyToSing(m: Media): boolean {
	return GATES.every((g) => !g.required || g.done(m));
}

/** The required steps still outstanding, in pipeline order. Empty ⇔ `readyToSing`. */
export function pendingGates(m: Media): ProcessGate[] {
	return GATES.filter((g) => g.required && !g.done(m));
}

/**
 * GATE-DRIVEN and never one hardcoded status, which only ever sees the FIRST step: a song mid-align is past
 * stems and not finished, so it matches neither "ready" nor "queued" and falls through to unacquired,
 * offering a Sing button on an already-separated song. Reading the table closes that for future gates too.
 */
export function isProcessing(m: Media): boolean {
	if (readyToSing(m)) return false;
	// Started = some gate reports done, OR the first step is enqueued. Only nothing-started is unacquired.
	return GATES.some((g) => g.done(m)) || m.stemStatus === 'queued';
}
