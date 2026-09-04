// The COOK GATES — one declaration of what "ready to sing" means, so adding a processing step is a
// one-line change instead of a hunt through call sites.
//
// This exists because `isPlayable` had quietly come to mean FOUR different things: can the TV player
// load this file, may rotation hand this entry to the TV, should the library list it, and should a
// re-cook be skipped. Adding "…and its lyrics are timed" to that one predicate would have made a song
// without lyrics get RE-COOKED from scratch, because `cookState` reads the same function to decide
// whether the work is already done. Those are different questions and now have different names:
//
//   playbackRef / hasInstrumental → "what file do I load" (the TV player, the re-cook check)
//   readyToSing                   → "is this song finished" (rotation, the library, the Ready group)
//
// Adding a future step (a loudness pass, a key-detection pass, a vocal-guide render) means adding one
// entry to GATES. Nothing else moves: every consumer already asks `readyToSing` / `pendingGates`.

import type { Media } from './types';

export interface CookGate {
	/** Stable id — matches the job type that satisfies it, so a log line reads the same on both sides. */
	readonly id: 'stems' | 'lyrics';
	/** What the phone says while this step is outstanding. */
	readonly pendingLabel: string;
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
export const GATES: readonly CookGate[] = [
	{
		id: 'stems',
		pendingLabel: 'Separating vocals',
		// Status AND artifact AND profile — all three from the ONE stems job, so this stays a single
		// gate under a single id (the id names the JOB TYPE that satisfies it, and there is no 'key'
		// job). The condition is the PRESENCE of the profile record, never that it carries key or range
		// DATA — mirroring the lyrics gate below, done means the analysis RAN, not that it found
		// anything. The trap it dodges: a silent vocal stem yields a profile of all nulls (a real
		// outcome — see media/loudness.ts and song-profile.ts), and a data-requiring gate would leave
		// that song unsingable FOREVER and never re-cook it either, because the re-cook check reads
		// hasInstrumental, not this gate. So it would sit at "Separating vocals" with no way out.
		done: (m) => m.stemStatus === 'ready' && !!m.instrumentalRef && !!m.songProfile,
		required: true
	},
	{
		id: 'lyrics',
		pendingLabel: 'Timing lyrics',
		// Ran, not "produced words". `lyricsRef` is absent for a genuine instrumental and that song is
		// still finished. Media cooked before this gate existed carry no lyricsStatus at all; they are
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
export function pendingGates(m: Media): CookGate[] {
	return GATES.filter((g) => g.required && !g.done(m));
}

/**
 * What the song is waiting on right now, for the phone's cooking sub-line — or `null` when finished.
 *
 * The FIRST outstanding step, because the pipeline is a chain: reporting "Timing lyrics" while
 * separation is still running would name a step that has not started.
 */
export function currentGateLabel(m: Media): string | null {
	return pendingGates(m)[0]?.pendingLabel ?? null;
}

/**
 * Is a cook in flight — the song is not finished, but the pipeline has already started on it?
 *
 * Gate-DRIVEN on purpose, and this is the bug it fixes. Readiness used to decide "cooking" with a
 * hardcoded `stemStatus === 'queued'`, which only ever saw the FIRST step. Once the lyrics gate
 * landed, a song mid-align has `stemStatus: 'ready'` and `lyricsStatus: 'queued'` — past the stems
 * check but not finished — so it matched neither "ready" nor "queued" and fell through to
 * "unacquired", showing a Sing button on an already-separated song.
 *
 * The gate-driven test is "has any step made progress but the song is not done yet". A gate that is
 * `done` means the cook got at least that far; a step whose status is `queued` means work is actively
 * enqueued. Either is "cooking". Reading it off the gate table rather than a single status means a
 * FUTURE gate cannot reopen this hole: a song sitting between two gates stays "cooking" automatically
 * because an earlier gate reports done.
 */
export function isCooking(m: Media): boolean {
	if (readyToSing(m)) return false;
	// "Started" = any gate already reports done (the cook got at least that far — this is what catches
	// the stems-ready / lyrics-queued window), OR the first step is actively enqueued (stems queued,
	// where no gate is done yet). Both are cooking; only a song with nothing started is unacquired.
	return GATES.some((g) => g.done(m)) || m.stemStatus === 'queued';
}
