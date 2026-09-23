// What a process LEARNED about a song's music. SONG, never SINGER: nothing here measures a person.
// Readiness and gate rules: docs/SERVER.md#song-profile-and-readiness.
//
// ASCII ACCIDENTALS ONLY — `G#`/`Ab`, never the typographic codepoints. A stripped smart-TV browser renders a
// glyph its font lacks as a tofu box, and the spelling a singer reads must not depend on font coverage.

/** A pitch class: semitones above C, octave-free. A NUMBER and not a spelled name, so transposition is
 *  modular and the spelling stays a rendering decision. */
export type PitchClass = number;

export type KeyMode = 'major' | 'minor';

/** How to spell a black note. Not cosmetic: transposing UP reads as sharps and DOWN as flats, so the
 *  direction of the shift picks the spelling. */
export type Accidental = 'sharp' | 'flat';

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** Below this the key is not shown at all: a template match reports a best correlation even for a song with
 *  no functional key, and a missing chip is honest where a wrong key is not. */
export const MIN_KEY_CONFIDENCE = 0.55;

/** The analysis a finished process attaches to a song: ALWAYS WRITTEN once the stems job completes, with every
 *  inner field nullable. That shape is what the `stems` gate reads — see
 *  docs/SERVER.md#song-profile-and-readiness. */
export interface SongProfile {
	/** Tonic of the detected key, or `null` when detection did not clear `MIN_KEY_CONFIDENCE`. */
	keyTonic: PitchClass | null;
	keyMode: KeyMode | null;
	/** 0..1 correlation of the winning key template. Kept even when it lost, so `/metrics` can show why. */
	keyConfidence: number | null;
	/** The absolute extremes of the sung melody; the WHISKERS on the range bar and never the headline, since one
	 *  shrieked grace note lands here. */
	lowMidi: number | null;
	highMidi: number | null;
	/** The 5th and 95th percentile of voiced frames — where the song LIVES, and the honest headline. */
	p05Midi: number | null;
	p95Midi: number | null;
	/** Seconds spent on each semitone from `lowMidi` upward (index 0 IS `lowMidi`). Stored rather than reduced,
	 *  because it drives the range block's shading. */
	histogram: number[] | null;
	/** Integrated loudness of the INSTRUMENTAL in LUFS — the instrumental, because that is what plays in the
	 *  room. `null` means NOT NORMALIZABLE: leave the level alone and never substitute a default. See
	 *  docs/SERVER.md#song-profile-and-readiness. */
	loudnessLufs: number | null;
}

/** The window a real integrated measurement can land in; outside it a value is a bad reading, not a quiet or
 *  loud song. The floor is the standard's own absolute gate, the ceiling what K-weighting can produce. */
export const MIN_MEASURABLE_LUFS = -70;
export const MAX_MEASURABLE_LUFS = 4;

/** A profile with no findings — what the worker publishes when analysis ran and came up empty. */
export const EMPTY_SONG_PROFILE: SongProfile = {
	keyTonic: null,
	keyMode: null,
	keyConfidence: null,
	lowMidi: null,
	highMidi: null,
	p05Midi: null,
	p95Midi: null,
	histogram: null,
	loudnessLufs: null
};

/** A profile whose key fields are all present — what {@link hasKey} narrows to. */
export type ProfileWithKey = SongProfile & { keyTonic: PitchClass; keyMode: KeyMode; keyConfidence: number };

/** Does this profile carry a key worth showing? The confidence floor is applied HERE, once. */
export function hasKey(p: SongProfile | null | undefined): p is ProfileWithKey {
	return (
		!!p &&
		p.keyTonic !== null &&
		p.keyMode !== null &&
		p.keyConfidence !== null &&
		p.keyConfidence >= MIN_KEY_CONFIDENCE
	);
}

/** A profile whose range fields are all present — what {@link hasVocalRange} narrows to. */
export type ProfileWithRange = SongProfile & { lowMidi: number; highMidi: number; p05Midi: number; p95Midi: number };

/** Does this profile carry a usable vocal range? Narrows `p`, so callers need no non-null assertions. */
export function hasVocalRange(p: SongProfile | null | undefined): p is ProfileWithRange {
	return !!p && p.lowMidi !== null && p.highMidi !== null && p.p05Midi !== null && p.p95Midi !== null;
}

/** Transpose a pitch class, wrapping. Negative shifts are handled without a negative modulo. */
export function transposePitchClass(tonic: PitchClass, semitones: number): PitchClass {
	return (((Math.trunc(tonic) + Math.trunc(semitones)) % 12) + 12) % 12;
}

/** Spell a key. Defaults to sharps; a caller showing a TRANSPOSED key must pass the shift's direction. */
export function keyLabel(tonic: PitchClass, mode: KeyMode, accidental: Accidental = 'sharp'): string {
	const names = accidental === 'flat' ? FLAT_NAMES : SHARP_NAMES;
	return `${names[transposePitchClass(tonic, 0)]} ${mode}`;
}

/** The key the room is HEARING. `null` with no trustworthy key, so a caller renders nothing rather than
 *  transposing a guess. */
export function soundingKeyLabel(p: SongProfile | null | undefined, keyShift: number): string | null {
	if (!hasKey(p)) return null;
	const shift = Math.trunc(keyShift);
	return keyLabel(transposePitchClass(p.keyTonic, shift), p.keyMode, shift < 0 ? 'flat' : 'sharp');
}

/** The song's ORIGINAL key, unshifted — `null` when undetected or below the confidence floor. */
export function originalKeyLabel(p: SongProfile | null | undefined): string | null {
	return hasKey(p) ? keyLabel(p.keyTonic, p.keyMode) : null;
}

/** MIDI number → scientific pitch name. Rounds first: a percentile boundary is fractional, and `D3.4` is not
 *  a note. */
export function midiToNoteName(midi: number): string {
	const n = Math.round(midi);
	const octave = Math.floor(n / 12) - 1;
	return `${SHARP_NAMES[((n % 12) + 12) % 12]}${octave}`;
}

/** `'D3 - A4'`, or `null` when the profile has no range. The dash is ASCII; see the header note. */
export function rangeLabel(p: SongProfile | null | undefined, semitones = 0): string | null {
	if (!hasVocalRange(p)) return null;
	const shift = Math.trunc(semitones);
	return `${midiToNoteName(p.p05Midi + shift)} - ${midiToNoteName(p.p95Midi + shift)}`;
}

/** How many octaves the range spans. MEASURED OVER THE SAME PAIR `rangeLabel` prints, because the two are
 *  rendered adjacent as one value. Takes no `semitones`: an interval is shift-invariant. */
export function rangeOctaves(p: SongProfile | null | undefined): number | null {
	if (!hasVocalRange(p)) return null;
	return Math.round(((p.p95Midi - p.p05Midi) / 12) * 10) / 10;
}

/** The axis the range bar is drawn against. It MATCHES the worker's pitch-tracker window, so a measured range
 *  can never fall off the ends of its own chart. */
export const AXIS_LOW_MIDI = 36; // C2
export const AXIS_HIGH_MIDI = 84; // C6

export interface VoiceBand {
	readonly id: 'bass' | 'baritone' | 'tenor' | 'alto' | 'soprano';
	readonly label: string;
	/** The band's true comfortable range in MIDI. THESE OVERLAP — see `voiceBandZones`. */
	readonly lowMidi: number;
	readonly highMidi: number;
}

/** The five conventional voice types with their real (overlapping) ranges. They describe MATERIAL, never
 *  people. TYPED NON-EMPTY, because `voiceBandFor` seeds its search with the first entry. */
export const VOICE_BANDS: readonly [VoiceBand, ...VoiceBand[]] = [
	{ id: 'bass', label: 'Bass', lowMidi: 40, highMidi: 64 }, // E2-E4
	{ id: 'baritone', label: 'Baritone', lowMidi: 45, highMidi: 69 }, // A2-A4
	{ id: 'tenor', label: 'Tenor', lowMidi: 48, highMidi: 72 }, // C3-C5
	{ id: 'alto', label: 'Alto', lowMidi: 53, highMidi: 77 }, // F3-F5
	{ id: 'soprano', label: 'Soprano', lowMidi: 60, highMidi: 84 } // C4-C6
] as const;

export type VoiceBandId = VoiceBand['id'];

export function isVoiceBandId(v: unknown): v is VoiceBandId {
	return typeof v === 'string' && VOICE_BANDS.some((b) => b.id === v);
}

/** Non-overlapping zones for SHADING the axis. AN APPROXIMATION THAT MUST STAY ONE — real bands overlap, so
 *  do not "fix" these into precise ranges; the claim made IN WORDS comes from `voiceBandFor`. */
export function voiceBandZones(): { id: VoiceBandId; label: string; lowMidi: number; highMidi: number }[] {
	const centre = (b: VoiceBand) => (b.lowMidi + b.highMidi) / 2;
	return VOICE_BANDS.map((b, i) => {
		const prev = VOICE_BANDS[i - 1];
		const next = VOICE_BANDS[i + 1];
		return {
			id: b.id,
			label: b.label,
			lowMidi: prev ? (centre(prev) + centre(b)) / 2 : AXIS_LOW_MIDI,
			highMidi: next ? (centre(b) + centre(next)) / 2 : AXIS_HIGH_MIDI
		};
	});
}

/** Which voice band this song sits in, from where it LIVES, using the TRUE overlapping ranges and not the
 *  display zones. `semitones` shifts first, so transposing moves the label. */
export function voiceBandFor(p: SongProfile | null | undefined, semitones = 0): VoiceBand | null {
	if (!hasVocalRange(p)) return null;
	const shift = Math.trunc(semitones);
	const songCentre = (p.p05Midi + p.p95Midi) / 2 + shift;
	let best = VOICE_BANDS[0];
	let bestDist = Infinity;
	for (const b of VOICE_BANDS) {
		const d = Math.abs((b.lowMidi + b.highMidi) / 2 - songCentre);
		if (d < bestDist) {
			bestDist = d;
			best = b;
		}
	}
	return best;
}

/** `'Sits in tenor range'` — describes the song, never the singer. `null` with no range. */
export function voiceBandSentence(p: SongProfile | null | undefined, semitones = 0): string | null {
	const band = voiceBandFor(p, semitones);
	return band ? `Sits in ${band.label.toLowerCase()} range` : null;
}

/** Where to draw the range bar, as 0..1 fractions of the axis. Clamped, so a freak measurement renders at the
 *  edge rather than overflowing its track. */
export function rangeBarFractions(
	p: SongProfile | null | undefined,
	semitones = 0
): { lo: number; hi: number; blockLo: number; blockHi: number } | null {
	if (!hasVocalRange(p)) return null;
	const shift = Math.trunc(semitones);
	const span = AXIS_HIGH_MIDI - AXIS_LOW_MIDI;
	const at = (midi: number) => Math.max(0, Math.min(1, (midi + shift - AXIS_LOW_MIDI) / span));
	return {
		lo: at(p.lowMidi),
		hi: at(p.highMidi),
		blockLo: at(p.p05Midi),
		blockHi: at(p.p95Midi)
	};
}

/** Normalize an untrusted profile off the wire. Every field is validated INDEPENDENTLY — a garbage key must
 *  not discard a good measured range — and `null` in gives `EMPTY_SONG_PROFILE` out, because "ran, found
 *  nothing" is a real gate-satisfying answer. */
export function normalizeSongProfile(input: unknown): SongProfile {
	if (!input || typeof input !== 'object') return { ...EMPTY_SONG_PROFILE };
	const o = input as Record<string, unknown>;

	const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

	const tonic = num(o.keyTonic);
	const mode = o.keyMode === 'major' || o.keyMode === 'minor' ? o.keyMode : null;
	const conf = num(o.keyConfidence);
	const keyOk = tonic !== null && tonic >= 0 && tonic <= 11 && mode !== null;

	const low = num(o.lowMidi);
	const high = num(o.highMidi);
	const p05 = num(o.p05Midi);
	const p95 = num(o.p95Midi);
	// A range is only meaningful as a COMPLETE, ORDERED set; a partial one renders a backwards bar.
	const rangeOk =
		low !== null && high !== null && p05 !== null && p95 !== null && low <= p05 && p05 <= p95 && p95 <= high;

	const hist = Array.isArray(o.histogram)
		? o.histogram.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0)
		: null;

	// Validated against the measurable WINDOW, not finiteness: trusting a bad reading attenuates on noise.
	const lufs = num(o.loudnessLufs);
	const lufsOk = lufs !== null && lufs >= MIN_MEASURABLE_LUFS && lufs <= MAX_MEASURABLE_LUFS;

	return {
		keyTonic: keyOk ? Math.trunc(tonic!) : null,
		keyMode: keyOk ? mode : null,
		keyConfidence: keyOk && conf !== null ? Math.max(0, Math.min(1, conf)) : null,
		lowMidi: rangeOk ? low : null,
		highMidi: rangeOk ? high : null,
		p05Midi: rangeOk ? p05 : null,
		p95Midi: rangeOk ? p95 : null,
		histogram: rangeOk && hist && hist.length > 0 ? hist : null,
		loudnessLufs: lufsOk ? lufs : null
	};
}
