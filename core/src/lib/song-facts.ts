/*
 * THE KEY AND RANGE READOUT, derived once. Three surfaces showed the same facts and each derived them itself: the
 * now-playing sheet and `routes/song/[mediaId]` had six character-identical `$derived` lines, and `routes/tv` built
 * the sounding-key string a third way. Nothing here touches the DOM, so it is testable without mounting anything —
 * which none of the three copies was. The sheet is deleted; its live controls are the now-playing card at the top
 * of `routes/queue`, which is the caller that replaced it. The three callers today are /queue, /song/[mediaId] and
 * /tv.
 *
 * TWO FORMS ON PURPOSE, and they must not be merged. The phone uses typographic punctuation (a real minus sign and a
 * middot); the TV uses ASCII `+`/`-` with a Latin-1 middot, because a typographic accidental or arrow is a codepoint
 * whose glyph a smart-TV browser may simply not have — there, a missing glyph is a tofu box in the middle of the one
 * line telling a singer what key they are hearing.
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
 * The TV's single-line form: what the room is HEARING, plus the shift. Null with no trustworthy key, so a song
 * without one shows nothing rather than a guess. ASCII throughout — see the header.
 */
export function soundingKeyLine(profile: SongProfile | null | undefined, keyShift: number): string | null {
	const label = soundingKeyLabel(profile, keyShift);
	if (!label) return null;
	return keyShift === 0 ? label : `${label} · ${keyShift > 0 ? '+' : ''}${keyShift}`;
}
