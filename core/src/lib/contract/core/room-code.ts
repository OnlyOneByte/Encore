// The short join code a phone types or a QR encodes. It is SHARED because both ends read it: the server
// mints and validates it, and the phone's segment entry must reject exactly the characters the server would,
// rather than accepting one and failing the join later. Two copies of one alphabet drift.

/**
 * Uppercase letters and digits with the visually confusable characters REMOVED (no 0/O, no 1/I/L), so a code
 * read off a TV and typed on a phone cannot be mistyped into a different VALID code.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A room code is exactly this many characters over {@link CODE_ALPHABET}. */
export const CODE_LENGTH = 6;

/** True when `ch` is one character the alphabet admits AFTER upper-casing, matching the segment input, which
 *  upper-cases first — so `a` is a legal `A` while `o` is still excluded. */
export function isRoomCodeChar(ch: string): boolean {
	return ch.length === 1 && CODE_ALPHABET.includes(ch.toUpperCase());
}

/**
 * Keep only admitted characters, upper-cased, capped at {@link CODE_LENGTH}. What a paste runs through:
 * punctuation and spaces are DROPPED rather than the whole paste refused, and the cap stops a long paste
 * overflowing the segment group.
 */
export function normalizeRoomCodeInput(raw: string): string {
	let out = '';
	for (const ch of raw) {
		if (out.length >= CODE_LENGTH) break;
		const up = ch.toUpperCase();
		if (CODE_ALPHABET.includes(up)) out += up;
	}
	return out;
}

/** The excluded characters, stated for the keystroke-rejection message. */
export const CODE_EXCLUDED_NOTE = 'Letters and numbers only — not O, I, L, 0 or 1.';
