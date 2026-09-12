// The PROCESS GATES — one declaration of what "ready to sing" means, so adding a processing step is a
// one-line change instead of a hunt through call sites.
//
// This exists because `isPlayable` had quietly come to mean FOUR different things: can the TV player
// load this file, may rotation hand this entry to the TV, should the library list it, and should a
// re-process be skipped. Adding "…and its lyrics are timed" to that one predicate would have made a song
// without lyrics get RE-PROCESSED from scratch, because `processState` reads the same function to decide
// whether the work is already done. Those are different questions and now have different names:
//
//   playbackRef / hasInstrumental → "what file do I load" (the TV player, the re-process check)
//   readyToSing                   → "is this song finished" (rotation, the library, the Ready group)
//
// Adding a future step (a loudness pass, a key-detection pass, a vocal-guide render) means adding one
// entry to GATES. Nothing else moves: every consumer already asks `readyToSing` / `pendingGates`.

import type { Media } from '../core/types';
import type { MediaStage } from '../core/events';

export interface ProcessGate {
	/** Stable id — matches the job type that satisfies it, so a log line reads the same on both sides. */
	readonly id: 'stems' | 'lyrics';
	/**
	 * The stop on `MEDIA_STAGES` a song sits at while this step is outstanding — the progress-bar
	 * datum the phone reads to place the process on its timeline.
	 *
	 * It lives HERE rather than in a lookup table next to its one consumer because of the promise this
	 * file opens with: adding a step is one entry in GATES and nothing else moves. A separate
	 * gate-id → stage map (the core's jobs/media-status.ts had one) quietly made that false — a new
	 * gate would need registering in two places, and the one that reports progress is the one a author
	 * adding a "loudness pass" would never think to look for.
	 */
	readonly stage: MediaStage;
	/**
	 * Is this step FINISHED for this song?
	 *
	 * A predicate rather than a bare status check, because "done" is not uniform: separation is only
	 * done when the status says ready AND the artifact key exists (they are written by separate steps,
	 * and a status without a ref hands the player an empty source), whereas alignment is done as soon
	 * as it has RUN — a song with no words is a legitimate result, so requiring a lyrics artifact would
	 * block every instrumental forever.
	 */
	readonly done: (m: Media) => boolean;
	/**
	 * Does singing WAIT for this step?
	 *
	 * Every gate here is required today. The flag exists so a future enrichment can be declared in the
	 * same table — visible to the progress UI, not blocking the turn — instead of being bolted on
	 * outside the model, which is how `score` and `align` ended up entangled with playability.
	 */
	readonly required: boolean;
}

/**
 * The pipeline, in order. THE place to add a step.
 *
 * `score` is deliberately absent: it produces a reference pitch track for live mic comparison, has no
 * enqueue path, and does not gate singing. See followUps in the core's dispatch.ts.
 */
export const GATES: readonly ProcessGate[] = [
	{
		id: 'stems',
		stage: 'separating',
		// Status AND artifact — both from the ONE stems job, so this stays a single gate under a single
		// id (the id names the JOB TYPE that satisfies it, and there is no 'key' job). Done means the
		// analysis RAN, not that it found anything: a silent vocal stem yields a profile of all nulls
		// (a real outcome — see media/loudness.ts and song-profile.ts) and that song is still finished.
		//
		// The profile record is deliberately NOT required here, and that is load-bearing. worker-hub
		// writes it unconditionally beside markMediaReady (setMediaSongProfile has no "no usable value"
		// outcome), so for any song THIS code processes, `stemStatus === 'ready'` already proves the profile
		// ran — the extra condition carried no information. What it did carry was a trap, the same one
		// the comment below the lyrics gate avoids: a library processed before profiles existed has no
		// record at all, so requiring it made every one of those songs unsingable FOREVER and
		// un-reprocessable too, because the re-process check reads hasInstrumental (isPlayable), not this
		// gate. They sat at "Separating vocals" with no way out. The all-nulls case was guarded; the
		// ABSENT case was not.
		//
		// A wire-shape regression that stops the profile arriving (it happened once — see the sibling
		// vs nested note at worker-hub.ts) is caught by the songProfile wire-shape parity test, which
		// fails loudly, rather than by this gate, which failed by stalling every song silently.
		done: (m) => m.stemStatus === 'ready' && !!m.instrumentalRef,
		required: true
	},
	{
		id: 'lyrics',
		stage: 'aligning',
		// Ran, not "produced words". `lyricsRef` is absent for a genuine instrumental and that song is
		// still finished. Media processed before this gate existed carry no lyricsStatus at all; they are
		// treated as done when they already have a lyrics artifact, so an existing library does not
		// silently become unsingable on upgrade.
		done: (m) => m.lyricsStatus === 'ready' || !!m.lyricsRef,
		required: true
	}
] as const;

/**
 * Is this song finished — every required step done?
 *
 * The single gate for rotation, the library list, and the phone's Ready group.
 */
export function readyToSing(m: Media): boolean {
	return GATES.every((g) => !g.required || g.done(m));
}

/** The required steps still outstanding, in pipeline order. Empty ⇔ `readyToSing`. */
export function pendingGates(m: Media): ProcessGate[] {
	return GATES.filter((g) => g.required && !g.done(m));
}

/**
 * Is a process in flight — the song is not finished, but the pipeline has already started on it?
 *
 * Gate-DRIVEN on purpose, and this is the bug it fixes. Readiness used to decide "processing" with a
 * hardcoded `stemStatus === 'queued'`, which only ever saw the FIRST step. Once the lyrics gate
 * landed, a song mid-align has `stemStatus: 'ready'` and `lyricsStatus: 'queued'` — past the stems
 * check but not finished — so it matched neither "ready" nor "queued" and fell through to
 * "unacquired", showing a Sing button on an already-separated song.
 *
 * The gate-driven test is "has any step made progress but the song is not done yet". A gate that is
 * `done` means the process got at least that far; a step whose status is `queued` means work is actively
 * enqueued. Either is "processing". Reading it off the gate table rather than a single status means a
 * FUTURE gate cannot reopen this hole: a song sitting between two gates stays "processing" automatically
 * because an earlier gate reports done.
 */
export function isProcessing(m: Media): boolean {
	if (readyToSing(m)) return false;
	// "Started" = any gate already reports done (the process got at least that far — this is what catches
	// the stems-ready / lyrics-queued window), OR the first step is actively enqueued (stems queued,
	// where no gate is done yet). Both are processing; only a song with nothing started is unacquired.
	return GATES.some((g) => g.done(m)) || m.stemStatus === 'queued';
}
