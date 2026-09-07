// What a cook LEARNED about a song's music: its key, and how high and low the original singer went.
//
// One record rather than two fields, and the name says SONG not SINGER on purpose. Nobody's voice is
// measured here — there is no per-singer calibration in Encore and no place to store one (`singers`
// is id/displayName/color/sessionToken/joinedAt). Everything below describes the MATERIAL, so the
// phone can answer "can I sing this, and what does the key button do to that answer" without ever
// having heard the person holding it.
//
// Both halves come out of the SAME stems job, which is what makes them one record:
//   • the key from the instrumental (`no_vocals.wav`) — a chroma profile of the full backing
//   • the range from the isolated vocals (`vocals.wav`) — the pitch track's voiced frames
// They are analysed while both WAVs are still in the worker's temp dir, before either is encoded, so
// the whole feature costs no extra separation, no extra decode, and no extra job type.
//
// KEY ACCURACY DOES NOT AFFECT THE RANGE. The range is measured MIDI off the vocal stem; the key is a
// template correlation that is right maybe three times in four on pop, with relative-major/minor and
// perfect-fifth confusions as its standard failures. A wrong key label is therefore cosmetic and
// cannot poison the range readout — which is why a low-confidence key is simply not shown while the
// range still is.
//
// ASCII ACCIDENTALS, DELIBERATELY. `G#`/`Ab`, never the typographic U+266F/U+266D. Those codepoints sit
// inside 0x2600-0x27BF, which `apps/core/src/lib/ui/icons.test.ts` bans outright from every client
// surface — and for the reason that applies here too: a stripped smart-TV browser renders a font it
// does not have as a tofu box, and the sharp sign is exactly as optional in a minimal font as an
// emoji is. The spelling a singer reads must not depend on the TV's font coverage.

/**
 * A pitch class: semitones above C, `0` = C through `11` = B. Octave-free.
 *
 * Stored as a NUMBER rather than a spelled name because transposition is then `(tonic + n) % 12` and
 * the spelling stays a rendering decision. A detector yields a pitch class; it has no opinion on
 * whether class 8 is `G#` or `Ab`, and baking one spelling into storage would make the stored value
 * wrong for half of all transpositions.
 */
export type PitchClass = number;

export type KeyMode = 'major' | 'minor';

/**
 * How to spell a black note: `sharp` -> `G#`, `flat` -> `Ab`.
 *
 * Not cosmetic. Transposing UP reads as sharps and DOWN as flats to anyone who has seen a chord
 * chart, so the direction of the singer's own key change picks the spelling — see `keyLabel`.
 */
export type Accidental = 'sharp' | 'flat';

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/**
 * Below this, the key is not shown at all.
 *
 * A chroma-template match reports a best correlation even for a song with no functional key
 * (spoken word, a drone, a drum track), so a confidence floor is the difference between "we think
 * it's G" and "we have no idea and said G anyway". The row simply omits the chip, matching the
 * omit-when-null convention every other chip in `SongRow` already follows — a missing chip is
 * honest, a wrong key is not.
 */
export const MIN_KEY_CONFIDENCE = 0.55;

/**
 * The analysis a finished cook attaches to a song. ALWAYS WRITTEN once the stems job completes, with
 * every inner field nullable.
 *
 * That "always written, inner fields nullable" shape is load-bearing, because this record is half of
 * the `stems` cook gate (see gates.ts). The gate has to distinguish:
 *
 *   • not analysed yet          -> profile absent      -> song is still cooking
 *   • analysed, found nothing   -> profile present, nulls inside -> song is FINISHED
 *
 * If the gate keyed on the presence of range DATA instead, a song whose vocal stem came back as
 * digital silence — which really happens, and is why `media/loudness.ts` exists — would be
 * permanently unsingable AND would never re-cook, because the re-cook check reads `hasInstrumental`
 * rather than the gate. It would sit at "Separating vocals" forever with no way out. This mirrors the
 * `lyrics` gate's own rule, quoted in its comment: done means the step RAN, not that it produced
 * output, because an instrumental with no words is a legitimate finished song.
 */
export interface SongProfile {
	/** Tonic of the detected key, or `null` when detection did not clear `MIN_KEY_CONFIDENCE`. */
	keyTonic: PitchClass | null;
	keyMode: KeyMode | null;
	/** 0..1 correlation of the winning key template. Kept even when it lost, so `/metrics` can show why. */
	keyConfidence: number | null;
	/**
	 * The absolute extremes of the sung melody, in MIDI note numbers. `null` when the vocal stem had no
	 * voiced frames at all (silence, an instrumental, or a separation that produced nothing pitched).
	 *
	 * These are the WHISKERS on the range bar and nothing more — one shrieked grace note lands here and
	 * would badly misrepresent the song if it were the headline. Use the percentiles for that.
	 */
	lowMidi: number | null;
	highMidi: number | null;
	/**
	 * The 5th and 95th percentile of voiced frames — where the song actually LIVES.
	 *
	 * This is the honest headline for "is this in my range", because it discards the tails that make
	 * every pop song look like it spans two octaves. Rendered as the solid block inside the whiskers.
	 */
	p05Midi: number | null;
	p95Midi: number | null;
	/**
	 * Seconds spent on each semitone from `lowMidi` upward — index 0 is `lowMidi`.
	 *
	 * Drives the SHADING weight of the range block, which is the whole reason a histogram is stored
	 * rather than four numbers: it is what makes a chorus that lives high look different from a verse
	 * that merely touches the same note once. `null` alongside a null range.
	 */
	histogram: number[] | null;
}

/** A profile with no findings — what the worker publishes when analysis ran and came up empty. */
export const EMPTY_SONG_PROFILE: SongProfile = {
	keyTonic: null,
	keyMode: null,
	keyConfidence: null,
	lowMidi: null,
	highMidi: null,
	p05Midi: null,
	p95Midi: null,
	histogram: null
};

/** Does this profile carry a key worth showing? Confidence floor applied here, once. */
export function hasKey(p: SongProfile | null | undefined): boolean {
	return (
		!!p &&
		p.keyTonic !== null &&
		p.keyMode !== null &&
		p.keyConfidence !== null &&
		p.keyConfidence >= MIN_KEY_CONFIDENCE
	);
}

/** Does this profile carry a usable vocal range? The percentiles are what the bar needs. */
export function hasVocalRange(p: SongProfile | null | undefined): boolean {
	return !!p && p.lowMidi !== null && p.highMidi !== null && p.p05Midi !== null && p.p95Midi !== null;
}

/** Transpose a pitch class, wrapping. Negative shifts are handled without a negative modulo. */
export function transposePitchClass(tonic: PitchClass, semitones: number): PitchClass {
	return (((Math.trunc(tonic) + Math.trunc(semitones)) % 12) + 12) % 12;
}

/**
 * Spell a key: `keyLabel(7, 'major')` -> `'G major'`.
 *
 * `accidental` defaults to sharps. Callers showing a TRANSPOSED key should pass the direction of the
 * shift instead (`keyShift < 0 ? 'flat' : 'sharp'`) so a singer dropping the key reads flats, which is
 * how the change is actually notated.
 */
export function keyLabel(tonic: PitchClass, mode: KeyMode, accidental: Accidental = 'sharp'): string {
	const names = accidental === 'flat' ? FLAT_NAMES : SHARP_NAMES;
	return `${names[transposePitchClass(tonic, 0)]} ${mode}`;
}

/**
 * The key the room is HEARING: the detected key moved by the current shift.
 *
 * Returns `null` when there is no trustworthy key to move, so a caller renders nothing rather than
 * transposing a guess. Spelling follows the shift's direction, per `keyLabel`.
 */
export function soundingKeyLabel(p: SongProfile | null | undefined, keyShift: number): string | null {
	if (!hasKey(p)) return null;
	const shift = Math.trunc(keyShift);
	return keyLabel(transposePitchClass(p!.keyTonic!, shift), p!.keyMode!, shift < 0 ? 'flat' : 'sharp');
}

/** The song's ORIGINAL key, unshifted — `null` when undetected or below the confidence floor. */
export function originalKeyLabel(p: SongProfile | null | undefined): string | null {
	return hasKey(p) ? keyLabel(p!.keyTonic!, p!.keyMode!) : null;
}

// ── note names ────────────────────────────────────────────────────────────────────

/** MIDI note number of middle C. Scientific pitch notation, so 60 is C4 and 69 is A4 (concert A). */
export const MIDI_C4 = 60;

/**
 * MIDI number -> scientific pitch name: `50` -> `'D3'`, `69` -> `'A4'`.
 *
 * A singer reads note names, not MIDI integers, so every range the UI shows goes through here.
 * Rounds first: a range boundary derived from a percentile is fractional, and `D3.4` is not a note.
 */
export function midiToNoteName(midi: number): string {
	const n = Math.round(midi);
	const octave = Math.floor(n / 12) - 1;
	return `${SHARP_NAMES[((n % 12) + 12) % 12]}${octave}`;
}

/** `'D3 - A4'`, or `null` when the profile has no range. The dash is ASCII; see the header note. */
export function rangeLabel(p: SongProfile | null | undefined, semitones = 0): string | null {
	if (!hasVocalRange(p)) return null;
	const shift = Math.trunc(semitones);
	return `${midiToNoteName(p!.p05Midi! + shift)} - ${midiToNoteName(p!.p95Midi! + shift)}`;
}

/** How many octaves the sung range spans, to one decimal — the "is this a big sing" number. */
export function rangeOctaves(p: SongProfile | null | undefined): number | null {
	if (!hasVocalRange(p)) return null;
	return Math.round(((p!.highMidi! - p!.lowMidi!) / 12) * 10) / 10;
}

// ── voice bands ───────────────────────────────────────────────────────────────────

/**
 * The axis the range bar is drawn against: C2 to C6, four octaves.
 *
 * Matches the vocal window the pitch tracker actually searches (`FMIN_HZ` 65 Hz is about C2,
 * `FMAX_HZ` 1175 Hz is about D6), so a measured range can never fall off the ends of its own chart.
 */
export const AXIS_LOW_MIDI = 36; // C2
export const AXIS_HIGH_MIDI = 84; // C6

export interface VoiceBand {
	readonly id: 'bass' | 'baritone' | 'tenor' | 'alto' | 'soprano';
	readonly label: string;
	/** The band's true comfortable range in MIDI. THESE OVERLAP — see `voiceBandZones`. */
	readonly lowMidi: number;
	readonly highMidi: number;
}

/**
 * The five conventional voice types, low to high, with their real ranges.
 *
 * Registry-shaped (`{id, label, ...}` + a guard + a resolver) to match `TV_PROGRESS_STYLES` and
 * `TV_BACKGROUND_STYLES`, so adding a band later is a table edit.
 *
 * These describe MATERIAL, not people: the UI says "sits in tenor range", never "for tenors". The
 * distinction matters at a party — a label that tells a guest what they are is a worse experience than
 * no label, and it would be wrong anyway, since nothing here measured them.
 *
 * TYPED NON-EMPTY (`[VoiceBand, ...VoiceBand[]]`) rather than `readonly VoiceBand[]`, because the
 * registry having a first entry is a real invariant that `voiceBandFor` depends on: it seeds its
 * nearest-centre search with `VOICE_BANDS[0]` and returns that seed if no band ever scores closer.
 * Under `noUncheckedIndexedAccess` a plain array makes that seed `VoiceBand | undefined`, so the
 * declared `VoiceBand | null` return was unassignable — the type understated the table, and the honest
 * fix is to state the invariant here rather than assert it away at the use site.
 */
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

/**
 * Non-overlapping zones for SHADING the axis, derived from `VOICE_BANDS`.
 *
 * THIS IS AN APPROXIMATION AND MUST STAY ONE. Real voice types overlap heavily — a tenor's C3-C5 sits
 * almost entirely inside an alto's F3-F5 — so they cannot be laid out as adjacent stripes on a single
 * linear axis without misstating them. Drawing the truth would need five stacked lanes, which does not
 * fit a phone.
 *
 * So the shading splits at the MIDPOINT BETWEEN ADJACENT BAND CENTRES: soft background colour that
 * tells a reader roughly where they are, while the actual claim the UI makes in words comes from
 * `voiceBandFor`, which uses the true overlapping ranges. Do not "fix" these zones into precise voice
 * ranges — they are not, and cannot be.
 */
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

/**
 * Which voice band this song sits in, from where it LIVES (the percentiles) rather than its extremes.
 *
 * Nearest band centre to the song's centre. Using the true overlapping ranges here — rather than the
 * display zones — is the point: the words the UI shows should be right even though the shading behind
 * them is a simplification.
 *
 * `semitones` shifts the range first, so transposing can move the label. That is the feature: tapping
 * `-2` and watching "Soprano" become "Alto" is what makes the key buttons mean something.
 */
export function voiceBandFor(p: SongProfile | null | undefined, semitones = 0): VoiceBand | null {
	if (!hasVocalRange(p)) return null;
	const shift = Math.trunc(semitones);
	const songCentre = (p!.p05Midi! + p!.p95Midi!) / 2 + shift;
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

/**
 * Where to draw the range bar, as fractions of the axis: whiskers (`lo`/`hi`) and the lives-here block
 * (`blockLo`/`blockHi`), each 0..1 left-to-right.
 *
 * Clamped to the axis so a freak measurement outside C2-C6 renders at the edge rather than overflowing
 * its track. Returns `null` with no range, so the caller renders nothing instead of an empty bar.
 */
export function rangeBarFractions(
	p: SongProfile | null | undefined,
	semitones = 0
): { lo: number; hi: number; blockLo: number; blockHi: number } | null {
	if (!hasVocalRange(p)) return null;
	const shift = Math.trunc(semitones);
	const span = AXIS_HIGH_MIDI - AXIS_LOW_MIDI;
	const at = (midi: number) => Math.max(0, Math.min(1, (midi + shift - AXIS_LOW_MIDI) / span));
	return {
		lo: at(p!.lowMidi!),
		hi: at(p!.highMidi!),
		blockLo: at(p!.p05Midi!),
		blockHi: at(p!.p95Midi!)
	};
}

// ── wire validation ───────────────────────────────────────────────────────────────

/**
 * Normalize an untrusted profile off the wire (a worker `complete` frame, or a sidecar written by an
 * older build) into a valid `SongProfile`.
 *
 * Every field is validated INDEPENDENTLY and a bad one degrades to `null` rather than rejecting the
 * record, because the two halves have independent producers: a garbage key must not throw away a
 * perfectly good measured range. `null` in, `EMPTY_SONG_PROFILE` out — "analysis ran, found nothing"
 * is a real and gate-satisfying answer, and refusing to represent it is what would strand a song.
 */
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
	// A range is only meaningful as a complete, ordered set. A half-written one is discarded whole
	// rather than half-trusted — an inverted or partial range would render a backwards bar.
	const rangeOk =
		low !== null && high !== null && p05 !== null && p95 !== null && low <= p05 && p05 <= p95 && p95 <= high;

	const hist = Array.isArray(o.histogram)
		? o.histogram.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0)
		: null;

	return {
		keyTonic: keyOk ? Math.trunc(tonic!) : null,
		keyMode: keyOk ? mode : null,
		keyConfidence: keyOk && conf !== null ? Math.max(0, Math.min(1, conf)) : null,
		lowMidi: rangeOk ? low : null,
		highMidi: rangeOk ? high : null,
		p05Midi: rangeOk ? p05 : null,
		p95Midi: rangeOk ? p95 : null,
		histogram: rangeOk && hist && hist.length > 0 ? hist : null
	};
}
