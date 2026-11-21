// Done-when: the key/range readout is derived in ONE place, and the phone's typographic form stays distinct from
// the TV's ASCII one. These six derivations were character-identical in the now-deleted now-playing sheet and in
// `routes/song/[mediaId]`, with a third variant on `routes/tv` — so no test could reach any of them. The sheet's
// live controls are /queue's now-playing card today, and it is the third caller.
import { test, expect } from 'bun:test';
import { songFacts, keyShiftLabel } from '$lib/song-facts';
import type { SongProfile } from '$lib/contract';

/** `keyTonic: 7` is G. Mirrors the fixture in tests/unit/contract/process/song-profile.test.ts. */
function profile(over: Partial<SongProfile> = {}): SongProfile {
	return {
		keyTonic: 7,
		keyMode: 'major',
		keyConfidence: 0.8,
		lowMidi: 48,
		highMidi: 72,
		p05Midi: 50,
		p95Midi: 69,
		histogram: [1, 2, 3],
		loudnessLufs: -12,
		...over
	} as SongProfile;
}

test('unshifted, the sounding key equals the original and nothing reads as shifted', () => {
	const f = songFacts(profile(), 0);
	expect(f.keyOriginal).toBe('G major');
	expect(f.keySounding).toBe('G major');
	expect(f.keyShifted).toBe(false);
	expect(f.keyLabel).toBe('Key');
});

test('a real transpose reports both keys and labels the shift', () => {
	const f = songFacts(profile(), 2);
	expect(f.keyOriginal).toBe('G major');
	expect(f.keySounding).toBe('A major');
	expect(f.keyShifted).toBe(true);
	expect(f.keyLabel).toBe('Key · +2');
});

test('THE THIRD CONDITION: a shift that lands back on the same label is not a shift', () => {
	// An octave round trip moves the pitch class nowhere, so announcing "transposed" would be a lie about the
	// readout the guest can see. This is why `keyShifted` compares LABELS rather than testing `keyShift !== 0`.
	const f = songFacts(profile(), 12);
	expect(f.keySounding).toBe(f.keyOriginal);
	expect(f.keyShifted).toBe(false);
});

test('a downward shift uses a real minus sign in the label, not a hyphen', () => {
	// The phone surfaces are typographic on purpose; the TV is not — see `keyShiftLabel`.
	expect(songFacts(profile(), -3).keyLabel).toBe('Key · −3');
	expect(songFacts(profile(), -3).keyLabel).not.toContain('-');
});

test('no trustworthy key means null on both, and not shifted — never a guess', () => {
	const f = songFacts(profile({ keyTonic: null, keyMode: null }), 5);
	expect(f.keyOriginal).toBe(null);
	expect(f.keySounding).toBe(null);
	// Load-bearing: an unknown sounding key cannot be compared, so it must not report as shifted.
	expect(f.keyShifted).toBe(false);
});

test('an absent profile yields every fact null rather than throwing', () => {
	for (const p of [null, undefined]) {
		const f = songFacts(p, 0);
		expect(f.keyOriginal).toBe(null);
		expect(f.rangeText).toBe(null);
		expect(f.octaves).toBe(null);
		expect(f.bandSentence).toBe(null);
		expect(f.keyShifted).toBe(false);
	}
});

test('the range facts come through for a profile that has them', () => {
	const f = songFacts(profile(), 0);
	expect(f.rangeText).toBeTruthy();
	expect(f.octaves).toBeGreaterThan(0);
});

// ── the TV's words ───────────────────────────────────────────────────────────

test('keyShiftLabel is ASCII, names the shift and never the key, and is silent at 0', () => {
	expect(keyShiftLabel(0)).toBe(null);
	expect(keyShiftLabel(2)).toBe('Key +2');
	const down = keyShiftLabel(-2);
	expect(down).toBe('Key -2');
	// The distinction from the phone's form, pinned: a real minus here would risk a tofu box mid-line.
	expect(down).not.toContain('−');
});
