/*
 * How the guiding track is held in time against the instrumental.
 *
 * This is a pure decision function so the policy can be tested without two real media elements. The
 * component owns the elements; this owns the answer to "given this much drift, what do we do?".
 *
 * The policy exists because of a specific defect. The guide used to be corrected by assigning
 * `vocals.currentTime` whenever it drifted more than 40ms, evaluated on the master's ~4Hz
 * `timeupdate`. Two media elements are never sample-locked, so 40ms was crossed almost continuously,
 * and every correction flushed the audio decoder — heard as a faint, near-continuous crackle under
 * the instrumental. A seek is not a small correction; it is the largest one available.
 *
 * So: ignore drift that does not matter, take out drift that does with a tempo trim (continuous, no
 * seam), and reserve seeking for a guide that is genuinely lost.
 */

/** Drift we simply do not care about. Chasing zero is what produced the crackle. */
export const GUIDE_DEADBAND_SEC = 0.015;
/** Past this the guide is desynced enough that one seam beats staying out of time. */
export const GUIDE_RESEEK_SEC = 0.3;
/**
 * Rate trim ceiling. Small on purpose: pitch preservation stays ON, so the browser time-stretches,
 * and a stretcher is transparent at 2% but smears audibly well below 10%.
 */
export const GUIDE_MAX_RATE_TRIM = 0.02;
/** Scaled so drift at the reseek threshold asks for exactly the maximum trim. */
export const GUIDE_RATE_GAIN = GUIDE_MAX_RATE_TRIM / GUIDE_RESEEK_SEC;

/**
 * Pre-roll and discontinuity alignment tolerance — how close the guide has to be to the instrumental
 * before a seek is not worth its decoder flush.
 *
 * Lives here rather than in the component because THREE paths need the same answer: the pre-roll
 * alignment taken when the guide can actually play (`prerollSeekTarget`), the re-alignment after a
 * jump (`seekPlan`), and the tolerance the drift governor's reseek band shares. Copies of one
 * tolerance is this repo's oldest habit and the reason the guide's transport once drifted from the
 * master's.
 */
export const GUIDE_PREROLL_ALIGN_SEC = 0.04;

/**
 * How far the room's reported position must sit from the playhead before it counts as a JUMP rather
 * than as telemetry.
 *
 * The ~4Hz position feed and every pause/resume carry a position, so the incoming value changes
 * constantly by small amounts. Acting on those would fight the playhead continuously; the threshold is
 * what separates "the phone scrubbed" from "the phone is reporting where we already are".
 */
export const SEEK_JUMP_SEC = 1.5;

/** Which elements a jump has to move. Both are answered together — see `seekPlan`. */
export interface SeekPlan {
	/** Reposition the instrumental (the master clock). */
	master: boolean;
	/** Reposition the guiding track. Never true unless `master` is: see `seekPlan`. */
	guide: boolean;
}

/**
 * Where a reported position leaves the two elements — the DISCONTINUITY half of guide sync.
 *
 * `guideCorrection` above owns continuous drift and deliberately prefers a tempo trim to a seam. That
 * is the right policy for drift and the wrong one for a jump: a 2% trim takes minutes to absorb a
 * restart, and any residual that lands back inside the trim band never hard-resyncs at all. So a jump
 * is corrected the way the pre-roll is — with a seek, on both elements, at the same moment. There is
 * already a seam on the master; the guide's costs nothing extra.
 *
 * `guide` IS GATED ON `master`, and that gating is load-bearing rather than tidiness. A guide that
 * evaluated the tolerance independently would chase every sub-threshold telemetry frame, seeking away
 * from a master that never moved — manufacturing the desync this function exists to prevent, and
 * flushing the decoder ~4 times a second while doing it.
 *
 * THE ZERO FIXED POINT. A `restart` sets the reported position to 0 (player.ts) while the song plays
 * on, so a restart pressed under `SEEK_JUMP_SEC` into the song — a currentTime below 1.5s — reads as
 * a sub-threshold move and the master never rewinds: the restart does nothing (#95). Telemetry cannot
 * report a target of 0 unless the song is genuinely at ~0, in which case the master is already there
 * and moving it is a no-op; so a target of exactly 0 with the master past the pre-roll tolerance is
 * unambiguously a rewind, never a telemetry frame. It is admitted as a jump on that basis, WITHOUT
 * relaxing the threshold for any non-zero target (which would reopen the telemetry-chasing this
 * function exists to prevent). The clause tests `targetSec === 0` — exact equality, load-bearing:
 * `restart` writes the integer literal 0 (player.ts), so 0 is a genuine FIXED POINT, not a value
 * that arrives near-zero from a computation. A future writer computing a near-zero restart target
 * would fall outside this clause and want its own reason to seek.
 *
 * @param masterSec the instrumental's playhead
 * @param guideSec  the guiding track's playhead (`NaN` when no guide is mounted — it is then ignored)
 * @param targetSec the position the room reported
 */
export function seekPlan(masterSec: number, guideSec: number, targetSec: number): SeekPlan {
	// Never seek on a guess, and never hand a non-finite value to `currentTime`. Matches
	// `guideCorrection`'s policy above; a NaN target reaching the element throws.
	if (!Number.isFinite(masterSec) || !Number.isFinite(targetSec)) return { master: false, guide: false };

	// A jump either moves far enough to clear the telemetry threshold, or it is a rewind to the
	// restart fixed point (target 0) from a master that is meaningfully past it. See THE ZERO FIXED
	// POINT above for why the second clause cannot fire on ordinary telemetry.
	const restartToZero = targetSec === 0 && masterSec > GUIDE_PREROLL_ALIGN_SEC;
	const master = Math.abs(masterSec - targetSec) > SEEK_JUMP_SEC || restartToZero;
	if (!master) return { master: false, guide: false };

	// A guide already at the target needs no flush. A non-finite guide playhead cannot be compared, so
	// it is treated as needing the seek — the element is about to be told where the master went, which
	// is the safe direction for a value we cannot reason about.
	const guide = !(Number.isFinite(guideSec) && Math.abs(guideSec - targetSec) <= GUIDE_PREROLL_ALIGN_SEC);
	return { master, guide };
}

export type GuideCorrection =
	/** Within the deadband: hold neutral, touch nothing. */
	| { kind: 'hold'; rate: 1 }
	/** Converge with a tempo trim. No decoder flush, so no seam. */
	| { kind: 'trim'; rate: number }
	/** Genuinely lost — accept one seam to get back in time. */
	| { kind: 'reseek'; rate: 1 };

/**
 * @param guideSec  the guide's playhead
 * @param masterSec the instrumental's playhead — the clock that actually drives the room
 */
export function guideCorrection(guideSec: number, masterSec: number): GuideCorrection {
	// A non-finite playhead means an element that is not ready to be reasoned about (an empty
	// duration, a torn-down element). Holding is the only safe answer: never seek on a guess.
	if (!Number.isFinite(guideSec) || !Number.isFinite(masterSec)) return { kind: 'hold', rate: 1 };

	// Positive drift = the guide is AHEAD of the instrumental.
	const drift = guideSec - masterSec;
	const magnitude = Math.abs(drift);

	if (magnitude > GUIDE_RESEEK_SEC) return { kind: 'reseek', rate: 1 };
	if (magnitude <= GUIDE_DEADBAND_SEC) return { kind: 'hold', rate: 1 };

	// Ahead → slow down (<1), behind → speed up (>1).
	const trim = Math.max(-GUIDE_MAX_RATE_TRIM, Math.min(GUIDE_MAX_RATE_TRIM, -drift * GUIDE_RATE_GAIN));
	return { kind: 'trim', rate: 1 + trim };
}

/**
 * The pre-roll alignment decision — the START half of guide sync, and the fix for #578.
 *
 * The guide must be at the master's playhead AT THE MOMENT IT BECOMES AUDIBLE. The old wiring aligned
 * it when the transport effect ran and then called `play()`: the guide's decoder spin-up is not free,
 * so the master advanced by the guide's start latency (~150-250ms) before the first guide frame
 * emerged, and the guide entered that much behind. A residual that size lands in the governor's TRIM
 * band (0.015-0.3s), where policy is a <=2% tempo trim closing it at ~15s per e-fold — "starts late
 * and stays late" (#578). The remedy is not a wider tolerance (that silences the comparison while the
 * guide is still audibly late); it is to TAKE the comparison later — on the guide's `canplay`, against
 * the master's playhead THEN — so the seek→audible gap is a primed-buffer flush, not a cold start.
 *
 * This owns only the decision, mirroring `seekPlan`/`guideCorrection`: the component owns the elements
 * and does the seek. `seek` is false inside `GUIDE_PREROLL_ALIGN_SEC` so an already-aligned guide is
 * never flushed for nothing — the same cost `guideCorrection` refuses to pay on ordinary drift — and
 * false on a non-finite playhead, because a NaN reaching `currentTime` throws and seeking on a guess is
 * never right.
 *
 * @param guideSec  the guide's playhead at the moment it can play
 * @param masterSec the instrumental's playhead at that same moment — the reference to lock onto
 * @returns whether to seek the guide, and the fixed target to seek it to
 */
export function prerollSeekTarget(guideSec: number, masterSec: number): { seek: boolean; target: number } {
	if (!Number.isFinite(guideSec) || !Number.isFinite(masterSec)) return { seek: false, target: masterSec };
	return { seek: Math.abs(guideSec - masterSec) > GUIDE_PREROLL_ALIGN_SEC, target: masterSec };
}
