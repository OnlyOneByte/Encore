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
