// Where the MASTER playhead goes when the room reports a position. The guide rides inside the master as channels 2/3 of
// one 4-channel file, so there is one decoder, one playhead and no inter-element drift.

// How far the room's reported position must sit from the playhead before it counts as a JUMP rather than telemetry: the
// ~4Hz feed and every pause/resume carry a position, so acting on small deltas fights the playhead continuously.
export const SEEK_JUMP_SEC = 1.5;

/** Shared by both places that reposition the master, so the tolerance cannot drift between call sites. */
export const PLAYHEAD_ALIGN_SEC = 0.04;

/**
 * THE ZERO FIXED POINT. `restart` writes the integer literal 0 while the song plays on, so a restart under
 * `SEEK_JUMP_SEC` into the song would read as sub-threshold telemetry and never rewind; telemetry cannot report 0 unless
 * the song really is at ~0, where seeking is a no-op. The exact EQUALITY is load-bearing: a future writer COMPUTING a
 * near-zero restart target falls outside the clause and needs its own reason to seek.
 */
export function seekPlan(masterSec: number, targetSec: number): boolean {
	// A NaN target reaching `currentTime` throws.
	if (!Number.isFinite(masterSec) || !Number.isFinite(targetSec)) return false;

	const restartToZero = targetSec === 0 && masterSec > PLAYHEAD_ALIGN_SEC;
	return Math.abs(masterSec - targetSec) > SEEK_JUMP_SEC || restartToZero;
}

/**
 * Deliberately NOT `seekPlan`, which compares against the master's current playhead — the one thing a cold mount
 * lacks — so routing a resume through it drops any resume under `SEEK_JUMP_SEC`. The caller applies this on `canplay`
 * ONCE per element-and-src load and then CLEARS the held target. See docs/FRONTEND.md#wake-lock-and-reload-resume.
 */
export function resumeSeekTarget(masterSec: number, targetSec: number): { seek: boolean; target: number } {
	if (!Number.isFinite(masterSec) || !Number.isFinite(targetSec)) return { seek: false, target: targetSec };
	return { seek: Math.abs(masterSec - targetSec) > PLAYHEAD_ALIGN_SEC, target: targetSec };
}
