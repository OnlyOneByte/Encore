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
} from './song-profile';

/** A fully-populated profile: G major, living D3-A4, extremes C3-C5. */
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

  // The guard in apps/core/src/lib/ui/icons.test.ts bans 0x2600-0x27BF from client surfaces, which
  // contains U+266F and U+266D. A label carrying one would render as tofu on a stripped TV font.
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
    // Not reachable through the UI (clamped to +/-7) but the maths must not drift.
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

  test('octave span comes from the true extremes', () => {
    expect(rangeOctaves(profile())).toBe(2); // C3..C5
    expect(rangeOctaves(profile({ lowMidi: 48, highMidi: 66 }))).toBe(1.5);
  });

  test('absent with no range', () => {
    expect(rangeLabel(EMPTY_SONG_PROFILE)).toBeNull();
    expect(rangeOctaves(EMPTY_SONG_PROFILE)).toBeNull();
    expect(rangeLabel(null)).toBeNull();
  });
});

describe('voice bands', () => {
  test('the registry is ordered low to high and every id guards', () => {
    // Folded over ADJACENT PAIRS rather than indexed, because `noUncheckedIndexedAccess` makes
    // `VOICE_BANDS[i]` possibly-undefined and the intent here is a pairwise walk, not an index
    // lookup. `reduce` with no seed hands the callback two definite `VoiceBand`s — and throws
    // outright on an empty registry, so this cannot start passing vacuously.
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
    // Asserted so nobody "fixes" the registry into non-overlapping ranges and calls it a cleanup.
    const tenor = VOICE_BANDS.find((b) => b.id === 'tenor')!;
    const alto = VOICE_BANDS.find((b) => b.id === 'alto')!;
    expect(alto.lowMidi).toBeLessThan(tenor.highMidi);
  });

  test('display zones tile the axis exactly once, with no gap and no overlap', () => {
    const zones = voiceBandZones();
    // One zone per band. Asserted because the fold below seeds `reduce`, and a seeded `reduce` over
    // an empty list returns the seed instead of throwing — without this the tiling check could pass
    // on no zones at all.
    expect(zones.length).toBe(VOICE_BANDS.length);
    // Walked as a CHAIN rather than by index, which is what `noUncheckedIndexedAccess` was objecting
    // to. Every claim the indexed version made survives: the AXIS_LOW_MIDI seed pins the first zone's
    // start, each step is the same no-gap/no-overlap check the pairwise loop made, the width check
    // runs on every zone, and the value the fold returns is the last zone's end.
    const end = zones.reduce((expectedLow, z) => {
      expect(z.lowMidi).toBe(expectedLow);
      expect(z.highMidi).toBeGreaterThan(z.lowMidi);
      return z.highMidi;
    }, AXIS_LOW_MIDI);
    expect(end).toBe(AXIS_HIGH_MIDI);
  });

  test('classifies a song by where it lives', () => {
    // Living D3-A4 centres on ~B3 (59.5), closest to tenor's centre (C3-C5 -> 60).
    expect(voiceBandFor(profile())!.id).toBe('tenor');
    // A high song: living C5-C6.
    expect(voiceBandFor(profile({ p05Midi: 72, p95Midi: 84 }))!.id).toBe('soprano');
    // A low song: living E2-E3.
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
    // The two halves have independent producers (instrumental vs vocal stem), so one being wrong
    // must never throw away the other.
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
    // The tonic is semitones above C, so 0 (C) and 11 (B) are the two ENDS of the valid set and 12 is
    // the first invalid value — it would be C an octave up, which is pitch class 0, not a 13th class.
    // Every existing key test probes 99 (absurd) or values well inside the range, so loosening the
    // bound to `<= 12` survives them all. These four pin the edges so it cannot.
    expect(normalizeSongProfile(profile({ keyTonic: 11 })).keyTonic).toBe(11); // B, the top class — valid
    expect(normalizeSongProfile(profile({ keyTonic: 0 })).keyTonic).toBe(0); // C, the bottom class — valid
    expect(normalizeSongProfile(profile({ keyTonic: 12 })).keyTonic).toBeNull(); // one past B — rejected
    expect(normalizeSongProfile(profile({ keyTonic: -1 })).keyTonic).toBeNull(); // one below C — rejected
    // A rejected tonic clears the whole key (mode too) rather than half-storing it.
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
    // This is the case the cook gate depends on: it must normalize to a present record, not to junk.
    expect(normalizeSongProfile(EMPTY_SONG_PROFILE)).toEqual(EMPTY_SONG_PROFILE);
  });
});
