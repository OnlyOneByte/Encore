// Loudness normalization — the PLAYBACK-side decision (PR3, "apply the gain").
//
// PR1 measures each instrumental's integrated loudness on the worker (BS.1770-4 via pyloudnorm) and
// PR2 persists it as `songProfile.loudnessLufs` (tri-state: a number in a measurable window, or
// `null` when it could not be measured — never a fabricated level). This module is the third leg:
// given the playing song's level and the levels of the songs in the library, decide how far — if at
// all — to pull the master instrumental DOWN before it plays.
//
// ── The owner's ruling (2026-09-09), implemented exactly ──────────────────────────────────────────
//
//   • OUTLIER CLAMP (ruling 1 = C). Leave most songs alone. Only a song whose measured loudness is
//     MORE than N dB above the library median gets attenuated.
//   • N = 6 dB. `N` = 3 would touch most modern masters; `N` = 6 touches only the loudest few, which
//     is the "I keep riding the volume" complaint and nothing more.
//   • PULL DOWN TO `median + N` — i.e. just inside the band, the SMALLEST correction that stops the
//     complaint, NOT all the way to the median. A song exactly at `median + N` or below is untouched.
//   • FLOOR = 8. No normalization at all until at least 8 songs carry a measured level. A median over
//     one or two songs is not a library median; clamping against it would attenuate real songs on
//     noise. Below the floor every song plays at unity.
//   • The median is taken over songs that HAVE a measured level. A `null` level is not a data point
//     and is never counted, and a `null`-level song is itself never attenuated (nothing to compare).
//   • ROOM KNOB. Whether any of this happens at all is a per-room `RoomSettings.loudnessNormalization`
//     toggle (see settings.ts). Off (the default) means unity for every song — today's behaviour.
//
// ── Attenuate-only is FORCED, not a design choice ─────────────────────────────────────────────────
//
// `PitchShiftGraph.setGain` clamps to `[0, 1]` and `HTMLMediaElement.volume` is 0..1, so there is no
// headroom above unity anywhere on the playback path. A quiet song can never be brought UP, only a
// loud one pulled DOWN. Every gain this module returns is therefore in `(0, 1]`: a song at or below
// the band, or any song when the feature is off / below floor / unmeasured, returns exactly `1`.
//
// This module is PURE (no DOM, no WebAudio, no I/O) so the decision is unit-testable without a
// browser. TvPlayer reads the returned gain and applies it at BOTH the native (`.volume`) and routed
// (`masterGraph.setGain`) sites.

/** dB a song's measured loudness must exceed the library median by before it is attenuated, and the
 *  headroom the correction leaves above the median (it is pulled to `median + N`, not to the median).
 *  Owner ruling: 6 dB. */
export const LOUDNESS_CLAMP_N_DB = 6;

/** Minimum count of songs carrying a measured level before ANY normalization applies. Owner ruling:
 *  8. Below this the "library median" is not a population and clamping would attenuate on noise. */
export const LOUDNESS_MEASURED_FLOOR = 8;

/**
 * The median of the measured loudness values, over songs that HAVE one.
 *
 * `null` entries are not data points — a song whose level could not be measured contributes nothing
 * to the population, per the tri-state contract. Non-finite values are dropped defensively (the
 * validator already rejects them upstream, but this function is pure and must not trust its input).
 *
 * Returns `null` when nothing measurable remains, so a caller can tell "no population" from "a real
 * median that happens to be 0". Even-count median is the mean of the two central values, the ordinary
 * definition — a fractional median is fine here because it only ever feeds a dB comparison.
 */
export function libraryLoudnessMedian(levels: ReadonlyArray<number | null | undefined>): number | null {
	const measured = levels.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
	if (measured.length === 0) return null;
	const sorted = [...measured].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	// Locals rather than indexing inline: under noUncheckedIndexedAccess a bare `sorted[mid]` is
	// `number | undefined`. `mid` and `mid - 1` are provably in range here (length >= 1), so `!` is the
	// honest assertion, not a guess.
	const hi = sorted[mid]!;
	if (sorted.length % 2 === 1) return hi;
	const lo = sorted[mid - 1]!;
	return (lo + hi) / 2;
}

/** Inputs to the playback normalization decision. Deliberately the raw facts, not pre-computed
 *  intermediates, so the whole ruling lives in one function and a test drives it end to end. */
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
 * Decide the master gain for the playing song under the owner's outlier-clamp ruling.
 *
 * Order of the guards is the order of the ruling: OFF → unity; this song has no measured level →
 * unity; fewer than `LOUDNESS_MEASURED_FLOOR` measured songs → unity; song at or below `median + N` →
 * unity; otherwise pull DOWN to `median + N`.
 *
 * The gain converts a dB pulldown to a linear multiplier: a song `d` dB above the target multiplies
 * by `10 ** (-d / 20)`. `d` is always positive here (we only enter this branch when the song is above
 * the band), so the gain is always in `(0, 1)` — never a boost, matching the attenuate-only path.
 */
export function loudnessNormalizationGain(input: LoudnessNormalizationInput): LoudnessNormalizationResult {
	if (!input.enabled) return UNITY(null, 0);

	// A song with no measured level is never touched — there is nothing to compare, and the tri-state
	// contract says `null` means "not normalizable", not "assume some default".
	const songLufs = input.songLufs;
	if (typeof songLufs !== 'number' || !Number.isFinite(songLufs)) return UNITY(null, 0);

	const measured = input.libraryLevels.filter(
		(v): v is number => typeof v === 'number' && Number.isFinite(v)
	);
	// Below the floor the median is not a library median; apply no gain to anything.
	if (measured.length < LOUDNESS_MEASURED_FLOOR) return UNITY(null, measured.length);

	const median = libraryLoudnessMedian(measured);
	// Unreachable given the floor (>=8 measured => a real median), but the type is `number | null` and
	// a pure function must not `!`-assert its way past that.
	if (median === null) return UNITY(null, measured.length);

	const target = median + LOUDNESS_CLAMP_N_DB;
	// At or below the band: untouched. This is the common case — the clamp is an OUTLIER clamp.
	if (songLufs <= target) return UNITY(median, measured.length);

	// Above the band: pull down to `target`. The song is `songLufs - target` dB too loud (positive),
	// so the linear gain is 10 ** (-(songLufs - target) / 20), which is < 1. Clamp to (0, 1] as a
	// belt-and-braces guard so a caller can trust the attenuate-only invariant without re-checking.
	const dbCut = target - songLufs; // negative
	const gain = Math.min(1, Math.max(0, 10 ** (dbCut / 20)));
	return { gain, attenuated: gain < 1, median, measuredCount: measured.length };
}
