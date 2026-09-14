/*
 * Where the MASTER playhead goes when the room reports a position — and nothing about a guide.
 *
 * WHAT THIS FILE USED TO BE, because the deletion is the interesting part. It was `guide-sync.ts`, and
 * most of it existed to hold a SECOND media element (the isolated vocals) in time against the
 * instrumental: a 15 ms deadband, a proportional tempo trim with a 2% ceiling, a 300 ms reseek
 * escalation, and a pre-roll lock-on taken on the guide's `canplay`. All of it is gone, along with the
 * second element itself.
 *
 * It was deleted rather than tuned because it could not be tuned. Every function in it compared the two
 * elements' reported `currentTime` — the spec's official playback position, which EXCLUDES each
 * element's output latency. Two independent decoders have different output latency, so the governor
 * read "aligned" (drift inside the deadband → hold) on a signal that does not describe what the ear
 * hears, and then correctly stopped correcting. The result was an audible offset that never self-healed
 * and that no threshold could reach, because the quantity at fault was invisible to the measurement.
 * A room only ever appeared to fix it by transposing, which captured both elements into ONE
 * AudioContext and so collapsed their latency difference by accident.
 *
 * The guide now rides inside the master as channels 2/3 of a 4-channel file (`guidePath` → `mix`), so
 * there is one decoder, one playhead, and no drift to govern. What remains here is the part that was
 * never about the guide at all: deciding whether a reported position is a real JUMP the master should
 * follow, or telemetry it should ignore.
 */

/**
 * How far the room's reported position must sit from the playhead before it counts as a JUMP rather
 * than as telemetry.
 *
 * The ~4Hz position feed and every pause/resume carry a position, so the incoming value changes
 * constantly by small amounts. Acting on those would fight the playhead continuously; the threshold is
 * what separates "the phone scrubbed" from "the phone is reporting where we already are".
 */
export const SEEK_JUMP_SEC = 1.5;

/**
 * Alignment tolerance — how close the master already has to be before a seek is not worth its decoder
 * flush.
 *
 * Shared by the two places that reposition the master: the cold-mount resume (`resumeSeekTarget`) and
 * the jump path's own no-op check. One constant rather than two copies, which is this repo's oldest
 * habit and the reason a tolerance once drifted between call sites.
 */
export const PLAYHEAD_ALIGN_SEC = 0.04;

/**
 * Does a reported position move the master?
 *
 * Returns a plain boolean. It used to be a `SeekPlan` object carrying a second `guide` field, gated on
 * this one, so that a jump repositioned both elements from a single decision — there is no second
 * element to reposition now, so the pair collapsed to the answer it always led with.
 *
 * THE ZERO FIXED POINT. A `restart` sets the reported position to 0 (player.ts) while the song plays
 * on, so a restart pressed under `SEEK_JUMP_SEC` into the song — a currentTime below 1.5s — reads as
 * a sub-threshold move and the master never rewinds: the restart does nothing. Telemetry cannot
 * report a target of 0 unless the song is genuinely at ~0, in which case the master is already there
 * and moving it is a no-op; so a target of exactly 0 with the master past the alignment tolerance is
 * unambiguously a rewind, never a telemetry frame. It is admitted as a jump on that basis, WITHOUT
 * relaxing the threshold for any non-zero target (which would reopen the telemetry-chasing this
 * function exists to prevent). The clause tests `targetSec === 0` — exact equality, load-bearing:
 * `restart` writes the integer literal 0 (player.ts), so 0 is a genuine FIXED POINT, not a value
 * that arrives near-zero from a computation. A future writer computing a near-zero restart target
 * would fall outside this clause and want its own reason to seek.
 *
 * @param masterSec the instrumental's playhead
 * @param targetSec the position the room reported
 */
export function seekPlan(masterSec: number, targetSec: number): boolean {
	// Never seek on a guess, and never hand a non-finite value to `currentTime`; a NaN target reaching
	// the element throws.
	if (!Number.isFinite(masterSec) || !Number.isFinite(targetSec)) return false;

	// A jump either moves far enough to clear the telemetry threshold, or it is a rewind to the
	// restart fixed point (target 0) from a master that is meaningfully past it. See THE ZERO FIXED
	// POINT above for why the second clause cannot fire on ordinary telemetry.
	const restartToZero = targetSec === 0 && masterSec > PLAYHEAD_ALIGN_SEC;
	return Math.abs(masterSec - targetSec) > SEEK_JUMP_SEC || restartToZero;
}

/**
 * The cold-mount RESUME decision.
 *
 * When the TV page is reloaded mid-song the room's position (`playback:state.positionSec`) arrives
 * BEFORE the `<audio>` master exists: the element is gated on `nowplaying:changed` filling the media
 * slot, which the server sends AFTER `playback:state`. The seek effect fires against a null `master`
 * and drops the target, and position telemetry never bumps `rev`, so `seekPlan`'s effect is never
 * re-woken and the target is never re-offered — the fresh master plays from 0 while the room is at 6s,
 * and the TV's own telemetry then drags the server's position backwards (measured: master 0.52s,
 * server falling from 6.00s).
 *
 * This is NOT a jump subject to `seekPlan`. `seekPlan` separates "the phone scrubbed" (a JUMP worth a
 * seam) from "the phone is reporting where we already are" (telemetry to ignore) by comparing the
 * target to the master's CURRENT playhead — which is exactly the playhead a cold mount does not have
 * yet. A fresh element sits at 0 with nothing to protect, so any room position more than an alignment
 * tolerance away is unambiguously a RESUME, not a scrub. Sending it through `seekPlan` would be wrong
 * twice: a resume to a position under `SEEK_JUMP_SEC` would be read as sub-threshold telemetry and
 * dropped (a reload 1s into a song would never resume), and the `restartToZero` clause would fire on a
 * genuine resume-to-0 that is already correct.
 *
 * So the resume gets its own threshold: seek iff the held target sits more than `PLAYHEAD_ALIGN_SEC`
 * from where the fresh element is. The component reads this on the master's `canplay` — when the buffer
 * is primed and the seek is a flush of a primed buffer rather than a cold start — and applies it ONCE
 * per element-and-src load, then clears the held target. Applied then cleared is what keeps the
 * stale-target defect shut: a stale target cannot be re-yanked onto a later song by catalog churn,
 * because there is no held target left to apply after the one resume it was taken for.
 *
 * @param masterSec the fresh master's playhead at the moment it can play (≈0 on a cold mount)
 * @param targetSec the room position held from the last `playback:state`
 * @returns whether to seek the master, and the fixed target to seek it to
 */
export function resumeSeekTarget(masterSec: number, targetSec: number): { seek: boolean; target: number } {
	if (!Number.isFinite(masterSec) || !Number.isFinite(targetSec)) return { seek: false, target: targetSec };
	return { seek: Math.abs(masterSec - targetSec) > PLAYHEAD_ALIGN_SEC, target: targetSec };
}
