import { test, expect, describe } from 'bun:test';
import {
	AXIS_HIGH_MIDI,
	AXIS_LOW_MIDI,
	EMPTY_SONG_PROFILE,
	MIN_KEY_CONFIDENCE,
	VOICE_BANDS,
	hasKey,
	hasVocalRange,
	isVoiceBandId,
	keyLabel,
	midiToNoteName,
	normalizeSongProfile,
	originalKeyLabel,
	rangeBarFractions,
	rangeLabel,
	rangeOctaves,
	soundingKeyLabel,
	transposePitchClass,
	voiceBandFor,
	voiceBandSentence,
	voiceBandZones,
	type SongProfile
} from '$lib/contract/process/song-profile';

/** A fully-populated profile: G major, living D3-A4, extremes C3-C5, mastered at -12 LUFS. */
function profile(over: Partial<SongProfile> = {}): SongProfile {
	return {
		keyTonic: 7,
		keyMode: 'major',
		keyConfidence: 0.8,
		lowMidi: 48, // C3
		highMidi: 72, // C5
		p05Midi: 50, // D3
		p95Midi: 69, // A4
		histogram: [1, 2, 3],
		loudnessLufs: -12,
		...over
	};
}

describe('pitch-class transposition', () => {
	test('wraps in both directions without a negative modulo', () => {
		expect(transposePitchClass(7, 0)).toBe(7);
		expect(transposePitchClass(7, 2)).toBe(9);
		expect(transposePitchClass(11, 1)).toBe(0); // B -> C, up over the wrap
		expect(transposePitchClass(0, -1)).toBe(11); // C -> B, down over the wrap
		expect(transposePitchClass(0, -13)).toBe(11); // more than an octave down still lands in 0..11
	});

	test('every shift in the supported +/-7 range stays a valid pitch class', () => {
		for (let tonic = 0; tonic < 12; tonic++) {
			for (let n = -7; n <= 7; n++) {
				const out = transposePitchClass(tonic, n);
				expect(out).toBeGreaterThanOrEqual(0);
				expect(out).toBeLessThanOrEqual(11);
				expect(Number.isInteger(out)).toBe(true);
			}
		}
	});
});

describe('key spelling', () => {
	test('names the natural keys', () => {
		expect(keyLabel(0, 'major')).toBe('C major');
		expect(keyLabel(7, 'major')).toBe('G major');
		expect(keyLabel(9, 'minor')).toBe('A minor');
	});

	test('spells black notes sharp by default and flat on request', () => {
		expect(keyLabel(8, 'major')).toBe('G# major');
		expect(keyLabel(8, 'major', 'flat')).toBe('Ab major');
		expect(keyLabel(1, 'minor', 'flat')).toBe('Db minor');
	});

	// The icon guard bans 0x2600-0x27BF from client surfaces, which contains U+266F and U+266D: a label
	// carrying one renders as tofu on a stripped TV font.
	test('never emits a typographic sharp or flat sign', () => {
		for (let tonic = 0; tonic < 12; tonic++) {
			for (const acc of ['sharp', 'flat'] as const) {
				const label = keyLabel(tonic, 'major', acc);
				expect(label).not.toContain('\u266F');
				expect(label).not.toContain('\u266D');
				for (const ch of label) expect(ch.codePointAt(0)!).toBeLessThan(0x2600);
			}
		}
	});
});

describe('the confidence floor', () => {
	test('a key at or above the floor is shown, below it is not', () => {
		expect(hasKey(profile({ keyConfidence: MIN_KEY_CONFIDENCE }))).toBe(true);
		expect(hasKey(profile({ keyConfidence: MIN_KEY_CONFIDENCE - 0.01 }))).toBe(false);
		expect(originalKeyLabel(profile({ keyConfidence: 0.2 }))).toBeNull();
	});

	test('an absent key is absent, not a default of C', () => {
		expect(hasKey(EMPTY_SONG_PROFILE)).toBe(false);
		expect(originalKeyLabel(EMPTY_SONG_PROFILE)).toBeNull();
		expect(originalKeyLabel(null)).toBeNull();
		expect(soundingKeyLabel(null, 2)).toBeNull();
	});
});

describe('sounding key', () => {
	test('moves with the shift, and spells by its direction', () => {
		const p = profile(); // G major
		expect(soundingKeyLabel(p, 0)).toBe('G major');
		expect(soundingKeyLabel(p, 2)).toBe('A major');
		expect(soundingKeyLabel(p, 1)).toBe('G# major'); // up -> sharp
		expect(soundingKeyLabel(p, -1)).toBe('Gb major'); // down -> flat
	});

	test('an octave either way returns to the original name', () => {
		// Not reachable through the UI (clamped to ±7), but the maths must not drift.
		expect(soundingKeyLabel(profile(), 12)).toBe('G major');
		expect(soundingKeyLabel(profile(), -12)).toBe('G major');
	});

	test('refuses to transpose a key it would not have shown', () => {
		expect(soundingKeyLabel(profile({ keyConfidence: 0.1 }), 3)).toBeNull();
	});
});

describe('note names', () => {
	test('uses scientific pitch notation anchored at middle C', () => {
		expect(midiToNoteName(60)).toBe('C4');
		expect(midiToNoteName(69)).toBe('A4'); // concert A
		expect(midiToNoteName(48)).toBe('C3');
		expect(midiToNoteName(36)).toBe('C2');
		expect(midiToNoteName(61)).toBe('C#4');
	});

	test('rounds a fractional boundary to a real note', () => {
		expect(midiToNoteName(59.6)).toBe('C4');
		expect(midiToNoteName(60.4)).toBe('C4');
	});
});

describe('range labels', () => {
	test('reports where the song lives, not its extremes', () => {
		expect(rangeLabel(profile())).toBe('D3 - A4'); // p05..p95, not lowMidi..highMidi
	});

	test('shifts with the key', () => {
		expect(rangeLabel(profile(), 2)).toBe('E3 - B4');
		expect(rangeLabel(profile(), -2)).toBe('C3 - G4');
	});

	// THE OCTAVE SPAN DESCRIBES THE INTERVAL THE LABEL PRINTS, so it must come from the same p05..p95
	// basis as `rangeLabel`: both are rendered ADJACENT as one value (`{rangeText}{octaves} oct`), so a
	// span taken from the true extremes reads as "A3 - A#4  3.7 oct". The third arm is load-bearing —
	// moving the EXTREMES must not move this number.
	test('the octave span describes the interval the label prints', () => {
		expect(rangeOctaves(profile())).toBe(1.6); // D3..A4, the labelled pair — not C3..C5's 2
		const p = profile({ p05Midi: 48, p95Midi: 66 });
		expect(rangeLabel(p)).toBe('C3 - F#4');
		expect(rangeOctaves(p)).toBe(1.5);
		expect(rangeOctaves(profile({ lowMidi: 36, highMidi: 84 }))).toBe(1.6);
	});

	// An interval is shift-invariant, which is why `rangeOctaves` takes no `semitones` where `rangeLabel`
	// does: transposing moves both ends by the same amount.
	test('the octave span is invariant under transposition', () => {
		expect(rangeOctaves(profile({ p05Midi: 52, p95Midi: 71 }))).toBe(rangeOctaves(profile()));
	});

	test('absent with no range', () => {
		expect(rangeLabel(EMPTY_SONG_PROFILE)).toBeNull();
		expect(rangeOctaves(EMPTY_SONG_PROFILE)).toBeNull();
		expect(rangeLabel(null)).toBeNull();
	});
});

describe('voice bands', () => {
	test('the registry is ordered low to high and every id guards', () => {
		// Folded over ADJACENT PAIRS rather than indexed: `reduce` with no seed hands the callback two
		// definite `VoiceBand`s and THROWS on an empty registry, so this cannot start passing vacuously.
		VOICE_BANDS.reduce((prev, band) => {
			expect(band.lowMidi).toBeGreaterThan(prev.lowMidi);
			expect(band.highMidi).toBeGreaterThan(prev.highMidi);
			return band;
		});
		for (const b of VOICE_BANDS) expect(isVoiceBandId(b.id)).toBe(true);
		expect(isVoiceBandId('countertenor')).toBe(false);
		expect(isVoiceBandId(undefined)).toBe(false);
	});

	test('the true ranges DO overlap — which is why the display zones exist', () => {
		// Asserted so the overlap cannot be "fixed" away as a cleanup.
		const tenor = VOICE_BANDS.find((b) => b.id === 'tenor')!;
		const alto = VOICE_BANDS.find((b) => b.id === 'alto')!;
		expect(alto.lowMidi).toBeLessThan(tenor.highMidi);
	});

	test('display zones tile the axis exactly once, with no gap and no overlap', () => {
		const zones = voiceBandZones();
		// One zone per band. The fold below SEEDS `reduce`, so it returns the seed instead of throwing on
		// an empty list — without this the tiling check could pass on no zones at all.
		expect(zones.length).toBe(VOICE_BANDS.length);
		// Walked as a CHAIN: the AXIS_LOW_MIDI seed pins the first zone's start, each step is the
		// no-gap/no-overlap check, the width check runs on every zone, and the fold returns the last end.
		const end = zones.reduce((expectedLow, z) => {
			expect(z.lowMidi).toBe(expectedLow);
			expect(z.highMidi).toBeGreaterThan(z.lowMidi);
			return z.highMidi;
		}, AXIS_LOW_MIDI);
		expect(end).toBe(AXIS_HIGH_MIDI);
	});

	test('classifies a song by where it lives', () => {
		expect(voiceBandFor(profile())!.id).toBe('tenor');
		expect(voiceBandFor(profile({ p05Midi: 72, p95Midi: 84 }))!.id).toBe('soprano');
		expect(voiceBandFor(profile({ p05Midi: 40, p95Midi: 52 }))!.id).toBe('bass');
	});

	test('transposing can move the label — the point of the feature', () => {
		const high = profile({ p05Midi: 69, p95Midi: 81 }); // soprano-ish
		expect(voiceBandFor(high, 0)!.id).toBe('soprano');
		expect(voiceBandFor(high, -7)!.id).not.toBe('soprano');
	});

	test('the sentence describes the SONG, never the singer', () => {
		const s = voiceBandSentence(profile())!;
		expect(s).toBe('Sits in tenor range');
		expect(s).not.toContain('for ');
		expect(s).not.toContain('you');
	});

	test('absent with no range', () => {
		expect(voiceBandFor(EMPTY_SONG_PROFILE)).toBeNull();
		expect(voiceBandSentence(EMPTY_SONG_PROFILE)).toBeNull();
	});
});

describe('range bar geometry', () => {
	test('fractions are ordered and inside the track', () => {
		const f = rangeBarFractions(profile())!;
		expect(f.lo).toBeLessThanOrEqual(f.blockLo);
		expect(f.blockLo).toBeLessThan(f.blockHi);
		expect(f.blockHi).toBeLessThanOrEqual(f.hi);
		for (const v of Object.values(f)) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	test('a measurement outside the axis clamps to the edge instead of overflowing', () => {
		const low = rangeBarFractions(profile({ lowMidi: 12, p05Midi: 14, p95Midi: 20, highMidi: 24 }))!;
		expect(low.lo).toBe(0);
		const high = rangeBarFractions(profile({ lowMidi: 90, p05Midi: 95, p95Midi: 100, highMidi: 108 }))!;
		expect(high.hi).toBe(1);
	});

	test('shifting slides the whole bar', () => {
		const a = rangeBarFractions(profile(), 0)!;
		const b = rangeBarFractions(profile(), 4)!;
		expect(b.blockLo).toBeGreaterThan(a.blockLo);
		expect(b.blockHi).toBeGreaterThan(a.blockHi);
	});

	test('absent with no range', () => {
		expect(rangeBarFractions(EMPTY_SONG_PROFILE)).toBeNull();
	});
});

describe('wire normalization', () => {
	test('a good record round-trips', () => {
		expect(normalizeSongProfile(profile())).toEqual(profile());
	});

	test('garbage in yields the empty profile, not a throw', () => {
		for (const bad of [null, undefined, 42, 'nope', [], true]) {
			expect(normalizeSongProfile(bad)).toEqual(EMPTY_SONG_PROFILE);
		}
	});

	test('a bad key does NOT discard a good range, and vice versa', () => {
		// Independent producers (instrumental vs vocal stem), so one being wrong must not discard the other.
		const keyBad = normalizeSongProfile(profile({ keyTonic: 99 }));
		expect(keyBad.keyTonic).toBeNull();
		expect(keyBad.keyMode).toBeNull();
		expect(keyBad.p05Midi).toBe(50);

		const rangeBad = normalizeSongProfile(profile({ p95Midi: null }));
		expect(rangeBad.p95Midi).toBeNull();
		expect(rangeBad.lowMidi).toBeNull(); // discarded as a set
		expect(rangeBad.keyTonic).toBe(7);
	});

	test('the key tonic is a pitch class: 0..11 accepted, either side rejected at the boundary', () => {
		// The tonic is semitones above C, so 0 and 11 are the ENDS of the valid set and 12 is the first
		// invalid value — C an octave up, which is pitch class 0. Only these four edge arms catch a bound
		// loosened to `<= 12`; a probe at 99 or well inside the range survives it.
		expect(normalizeSongProfile(profile({ keyTonic: 11 })).keyTonic).toBe(11); // B, the top class — valid
		expect(normalizeSongProfile(profile({ keyTonic: 0 })).keyTonic).toBe(0); // C, the bottom class — valid
		expect(normalizeSongProfile(profile({ keyTonic: 12 })).keyTonic).toBeNull(); // one past B — rejected
		expect(normalizeSongProfile(profile({ keyTonic: -1 })).keyTonic).toBeNull(); // one below C — rejected
		// A rejected tonic clears the whole key, mode included, rather than half-storing it.
		expect(normalizeSongProfile(profile({ keyTonic: 12 })).keyMode).toBeNull();
		expect(normalizeSongProfile(profile({ keyTonic: -1 })).keyMode).toBeNull();
	});

	test('an out-of-order range is discarded whole rather than rendered backwards', () => {
		const inverted = normalizeSongProfile(profile({ p05Midi: 69, p95Midi: 50 }));
		expect(hasVocalRange(inverted)).toBe(false);
	});

	test('rejects a non-numeric mode and clamps confidence', () => {
		expect(normalizeSongProfile(profile({ keyMode: 'lydian' as never })).keyMode).toBeNull();
		expect(normalizeSongProfile(profile({ keyConfidence: 5 })).keyConfidence).toBe(1);
		expect(normalizeSongProfile(profile({ keyConfidence: -5 })).keyConfidence).toBe(0);
	});

	test('drops a histogram that is not a list of non-negative numbers', () => {
		expect(normalizeSongProfile(profile({ histogram: ['a'] as never })).histogram).toBeNull();
		expect(normalizeSongProfile(profile({ histogram: [] })).histogram).toBeNull();
		expect(normalizeSongProfile(profile({ histogram: [1, -2, 3] })).histogram).toEqual([1, 3]);
	});

	test('the empty profile is a valid record — "ran, found nothing" survives the wire', () => {
		// The process gate depends on this: it must normalize to a PRESENT record, not to junk.
		expect(normalizeSongProfile(EMPTY_SONG_PROFILE)).toEqual(EMPTY_SONG_PROFILE);
	});

	// A LEVEL is trusted only inside the window a real BS.1770 measurement can occupy. Every bound is
	// hard-coded from the standard rather than read off the exported constants, so widening the window in
	// the validator cannot silently widen the test with it.

	test('a real measured level round-trips unrounded', () => {
		// Not clamped, not rounded: the gain the room derives is only as good as this number.
		expect(normalizeSongProfile(profile({ loudnessLufs: -13.37 })).loudnessLufs).toBe(-13.37);
	});

	test('null stays null — an unmeasurable stem never acquires a default level', () => {
		// Substituting 0 reads as a deafening master and attenuates the song into inaudibility, which is
		// worse than the uneven library the feature exists to fix.
		expect(normalizeSongProfile(profile({ loudnessLufs: null })).loudnessLufs).toBeNull();
		expect(normalizeSongProfile({}).loudnessLufs).toBeNull();
	});

	test('the measurable window is closed at both ends: -70 and 4 in, one step past either out', () => {
		// -70 LUFS is BS.1770's absolute gate (below it every gating block is discarded) and +4 is what
		// K-weighting's stage-1 high shelf can add to full-scale content. Both ends INCLUSIVE.
		expect(normalizeSongProfile(profile({ loudnessLufs: -70 })).loudnessLufs).toBe(-70);
		expect(normalizeSongProfile(profile({ loudnessLufs: 4 })).loudnessLufs).toBe(4);
		expect(normalizeSongProfile(profile({ loudnessLufs: -70.1 })).loudnessLufs).toBeNull();
		expect(normalizeSongProfile(profile({ loudnessLufs: 4.1 })).loudnessLufs).toBeNull();
	});

	test('an out-of-window level is DISCARDED, not clamped into the window', () => {
		// Clamping is the wrong failure direction: a bogus -200 clamped to -70 is a number the room then
		// attenuates a real song against. null means "not normalizable, leave it alone".
		expect(normalizeSongProfile(profile({ loudnessLufs: -200 })).loudnessLufs).toBeNull();
		expect(normalizeSongProfile(profile({ loudnessLufs: 120 })).loudnessLufs).toBeNull();
	});

	test('a non-finite or non-numeric level degrades to null', () => {
		for (const bad of [NaN, Infinity, -Infinity, '-12' as never, {} as never]) {
			expect(normalizeSongProfile(profile({ loudnessLufs: bad })).loudnessLufs).toBeNull();
		}
	});

	test('the level is its OWN half: a bad key or range does not discard it, nor it them', () => {
		// Three independent producers — key from the instrumental's chromagram, range from the vocal stem,
		// level from the instrumental's samples — so one bad reading must not discard the other two.
		const keyBad = normalizeSongProfile(profile({ keyTonic: 99 }));
		expect(keyBad.keyTonic).toBeNull();
		expect(keyBad.loudnessLufs).toBe(-12);

		const rangeBad = normalizeSongProfile(profile({ p95Midi: null }));
		expect(rangeBad.lowMidi).toBeNull();
		expect(rangeBad.loudnessLufs).toBe(-12);

		const levelBad = normalizeSongProfile(profile({ loudnessLufs: 999 }));
		expect(levelBad.loudnessLufs).toBeNull();
		expect(levelBad.keyTonic).toBe(7);
		expect(levelBad.p05Midi).toBe(50);
	});
});
