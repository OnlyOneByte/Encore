/*
 * THE KEY AND RANGE READOUT, derived once. Three surfaces showed the same facts and each derived them itself: the
 * now-playing sheet and `routes/song/[mediaId]` had six character-identical `$derived` lines, and `routes/tv` built
 * the sounding-key string a third way. Nothing here touches the DOM, so it is testable without mounting anything —
 * which none of the three copies was. The sheet is deleted; its live controls are the now-playing card at the top
 * of `routes/queue`, which is the caller that replaced it. The three callers today are /queue, /song/[mediaId] and
 * /tv.
 *
 * THE KEY NAME IS THE PHONE'S. The TV shows only the SHIFT (`keyShiftLabel`), never `A minor`: the room cannot use a
 * music-theory name, and the singer already reads it on their phone where they pick the key.
 */
import {
	originalKeyLabel,
	rangeLabel,
	rangeOctaves,
	soundingKeyLabel,
	voiceBandSentence,
	type SongProfile
} from '$lib/contract';

export interface SongFacts {
	/** The key as recorded, or null when no key is trustworthy — never a guess. */
	keyOriginal: string | null;
	/** What is actually SOUNDING, once the transpose is applied. */
	keySounding: string | null;
	/** Whether the two differ in a way worth showing. A shift that lands back on the same label is not a shift. */
	keyShifted: boolean;
	/** The field's own label, carrying the shift: `Key` or `Key · +2`. Typographic minus — phone surfaces only. */
	keyLabel: string;
	rangeText: string | null;
	octaves: number | null;
	bandSentence: string | null;
}

/** Every fact the phone's key/range block shows, from the one profile and the one shift. */
export function songFacts(profile: SongProfile | null | undefined, keyShift: number): SongFacts {
	const keyOriginal = originalKeyLabel(profile);
	const keySounding = soundingKeyLabel(profile, keyShift);
	return {
		keyOriginal,
		keySounding,
		// All three conditions matter: no shift is not shifted, an unknown sounding key cannot be compared, and a
		// shift that resolves to the SAME label (an enharmonic round trip) is not something to announce.
		keyShifted: keyShift !== 0 && keySounding !== null && keySounding !== keyOriginal,
		keyLabel: keyShift === 0 ? 'Key' : `Key · ${keyShift > 0 ? '+' : '−'}${Math.abs(keyShift)}`,
		rangeText: rangeLabel(profile, keyShift),
		octaves: rangeOctaves(profile),
		bandSentence: voiceBandSentence(profile, keyShift)
	};
}

/**
 * The TV's key words: `Key −2` / `Key +3` while the song is shifted, null at 0 so nothing shows. The lower third's
 * line, the TV's one key display.
 */
export function keyShiftLabel(semitones: number): string | null {
	return semitones ? `Key ${semitones > 0 ? '+' : '−'}${Math.abs(semitones)}` : null;
}
