// Loudness normalization: given the playing song's measured level and the library's, how far to pull the
// master instrumental DOWN. PURE — no DOM, no WebAudio, no I/O.
//
// AN OUTLIER CLAMP, which the guard order below implements literally: most songs are untouched, only one more
// than N dB above the library median moves, and it is pulled only to `median + N`. Nothing happens at all
// below `LOUDNESS_MEASURED_FLOOR` measured songs, or with the room's toggle off. A `null` level is not a data
// point in the median and a `null`-level song is never attenuated, because there is nothing to compare.
//
// ATTENUATE-ONLY IS FORCED, not chosen: nothing on the playback path has headroom above unity, since both the
// gain node and `HTMLMediaElement.volume` clamp to `[0, 1]`. Every gain returned here is in `(0, 1]`.

/** dB above the library median a song must measure before it is attenuated, AND the headroom the correction
 *  leaves above that median. 6 dB touches only the loudest few masters; 3 would touch most modern ones. */
export const LOUDNESS_CLAMP_N_DB = 6;

/** Minimum measured-song count before ANY normalization applies. Below it the "library median" is not a
 *  population and clamping against it attenuates real songs on noise. */
export const LOUDNESS_MEASURED_FLOOR = 8;

/**
 * The median over songs that HAVE a measured level. `null` entries are not data points and contribute
 * nothing; non-finite values are dropped defensively, because a pure function must not trust its input.
 *
 * Returns `null` when nothing measurable remains, so a caller can tell "no population" from "a real median
 * that happens to be 0".
 */
export function libraryLoudnessMedian(levels: ReadonlyArray<number | null | undefined>): number | null {
	const measured = levels.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
	if (measured.length === 0) return null;
	const sorted = [...measured].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	// Locals rather than inline indexing: under `noUncheckedIndexedAccess` both indices are provably in
	// range here, so `!` is an honest assertion rather than a guess.
	const hi = sorted[mid]!;
	if (sorted.length % 2 === 1) return hi;
	const lo = sorted[mid - 1]!;
	return (lo + hi) / 2;
}

/** Inputs to the decision. Deliberately RAW FACTS rather than pre-computed intermediates, so the whole rule
 *  lives in one function and a test drives it end to end. */
export interface LoudnessNormalizationInput {
	/** The playing song's measured integrated loudness (LUFS), or `null` if it has none. */
	songLufs: number | null | undefined;
	/** Every measured level in the library, INCLUDING this song's. `null`/absent entries are ignored;
	 *  the count of the measured ones is what the floor is checked against. */
	libraryLevels: ReadonlyArray<number | null | undefined>;
	/** The room's `loudnessNormalization` toggle. When false, the result is always unity. */
	enabled: boolean;
}

/** The decision, as facts a caller (or a test) can assert against — not just the gain. */
export interface LoudnessNormalizationResult {
	/** The linear gain to apply to the master, in `(0, 1]`. `1` = untouched. Never above unity. */
	gain: number;
	/** True only when a real pulldown was applied (`gain < 1`). */
	attenuated: boolean;
	/** The library median used, or `null` when the feature did not run (off, below floor, no
	 *  population). Exposed for telemetry / tests, not required by the caller. */
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

/**
 * The master gain for the playing song. THE GUARD ORDER IS THE RULE: off → unity; no measured level → unity;
 * below the measured-song floor → unity; at or below `median + N` → unity; otherwise pull down to it.
 */
export function loudnessNormalizationGain(input: LoudnessNormalizationInput): LoudnessNormalizationResult {
	if (!input.enabled) return UNITY(null, 0);

	// No measured level means NOT NORMALIZABLE, never "assume a default": there is nothing to compare.
	const songLufs = input.songLufs;
	if (typeof songLufs !== 'number' || !Number.isFinite(songLufs)) return UNITY(null, 0);

	const measured = input.libraryLevels.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
	if (measured.length < LOUDNESS_MEASURED_FLOOR) return UNITY(null, measured.length);

	const median = libraryLoudnessMedian(measured);
	// Unreachable past the floor, but the type is nullable and a pure function must not assert past that.
	if (median === null) return UNITY(null, measured.length);

	const target = median + LOUDNESS_CLAMP_N_DB;
	// At or below the band: untouched, which is the common case — this is an OUTLIER clamp.
	if (songLufs <= target) return UNITY(median, measured.length);

	// Clamped to (0, 1] as well as derived that way, so a caller can trust the attenuate-only invariant
	// without re-checking it.
	const dbCut = target - songLufs; // negative
	const gain = Math.min(1, Math.max(0, 10 ** (dbCut / 20)));
	return { gain, attenuated: gain < 1, median, measuredCount: measured.length };
}
