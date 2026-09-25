// How far to pull the master instrumental DOWN. PURE — no DOM, no WebAudio, no I/O.
//
// AN OUTLIER CLAMP, which the guard order below implements literally: only a song more than N dB above the
// library median moves, and only to `median + N`. A `null` level is not a data point in the median, and such
// a song is never attenuated, because there is nothing to compare.
//
// ATTENUATE-ONLY IS FORCED, not chosen: the gain node and `HTMLMediaElement.volume` both clamp to `[0, 1]`,
// so nothing on the playback path has headroom above unity.

/** Both the trigger and the headroom the correction leaves. 6 dB touches only the loudest few masters;
 *  3 would touch most modern ones. */
export const LOUDNESS_CLAMP_N_DB = 6;

/** Below this the "library median" is not a population, and clamping against it attenuates on noise. */
export const LOUDNESS_MEASURED_FLOOR = 8;

/** A DATA POINT: `null` entries are not, and a non-finite value is dropped defensively, because a pure
 *  function must not trust its input. The ONE definition, so the median and the floor count the same set. */
function isMeasured(v: number | null | undefined): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Returns `null` when nothing measurable remains, so a caller can tell "no population" from "a real median
 * that happens to be 0".
 */
export function libraryLoudnessMedian(levels: ReadonlyArray<number | null | undefined>): number | null {
	const measured = levels.filter(isMeasured);
	if (measured.length === 0) return null;
	const sorted = [...measured].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	// Locals rather than inline indexing: both indices are provably in range here, so `!` is honest.
	const hi = sorted[mid]!;
	if (sorted.length % 2 === 1) return hi;
	const lo = sorted[mid - 1]!;
	return (lo + hi) / 2;
}

/** RAW FACTS rather than pre-computed intermediates, so the whole rule lives in one function. */
export interface LoudnessNormalizationInput {
	/** The playing song's measured integrated loudness (LUFS), or `null` if it has none. */
	songLufs: number | null | undefined;
	/** INCLUDING this song's. The count of the MEASURED ones is what the floor is checked against. */
	libraryLevels: ReadonlyArray<number | null | undefined>;
	/** The room's `loudnessNormalization` toggle. When false, the result is always unity. */
	enabled: boolean;
}

/** Facts a caller or a test can assert against, not just the gain. */
export interface LoudnessNormalizationResult {
	/** The linear gain to apply to the master, in `(0, 1]`. `1` = untouched. Never above unity. */
	gain: number;
	/** True only when a real pulldown was applied (`gain < 1`). */
	attenuated: boolean;
	/** `null` when the feature did not run. Telemetry only; not required by the caller. */
	median: number | null;
	/** Count of measured songs the median was taken over (0 when the feature did not run). */
	measuredCount: number;
}

const UNITY = (median: number | null, measuredCount: number): LoudnessNormalizationResult => ({
	gain: 1,
	attenuated: false,
	median,
	measuredCount
});

/** THE GUARD ORDER IS THE RULE: off → unity; no measured level → unity; below the measured-song floor →
 *  unity; at or below `median + N` → unity; otherwise pull down to it. */
export function loudnessNormalizationGain(input: LoudnessNormalizationInput): LoudnessNormalizationResult {
	if (!input.enabled) return UNITY(null, 0);

	// No measured level means NOT NORMALIZABLE, never "assume a default": there is nothing to compare.
	const songLufs = input.songLufs;
	if (!isMeasured(songLufs)) return UNITY(null, 0);

	const measured = input.libraryLevels.filter(isMeasured);
	if (measured.length < LOUDNESS_MEASURED_FLOOR) return UNITY(null, measured.length);

	const median = libraryLoudnessMedian(measured);
	// Unreachable past the floor, but the type is nullable and purity must not assert past that.
	if (median === null) return UNITY(null, measured.length);

	const target = median + LOUDNESS_CLAMP_N_DB;
	// The common case: untouched. This is an OUTLIER clamp.
	if (songLufs <= target) return UNITY(median, measured.length);

	// Clamped as well as derived that way, so a caller can trust attenuate-only without re-checking.
	const dbCut = target - songLufs; // negative
	const gain = Math.min(1, Math.max(0, 10 ** (dbCut / 20)));
	return { gain, attenuated: gain < 1, median, measuredCount: measured.length };
}
