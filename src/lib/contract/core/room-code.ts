// Room-code vocabulary — the shared truth for the short join code a phone types or a QR encodes.
//
// This lives in $lib/contract, not., ON PURPOSE. The code is now read at BOTH ends of
// the wire: the server mints and validates it (`src/lib/server/rooms/repository.ts`), and the
// phone's six-segment entry (`routes/+page.svelte`) must reject a character the server would
// reject rather than accept it and fail the join later. Two copies of one alphabet with no parity guard
// is the `internal` defect shape — so the alphabet has one home, imported by
// both. `repository.ts` re-exports these so its existing importers do not move.

/**
 * Join-code alphabet: uppercase letters + digits with the visually confusable characters removed
 * (no 0/O, 1/I/L) so a code read off a TV and typed on a phone cannot be mistyped into a different
 * valid code. Six characters over this 30-symbol alphabet is ~7.3e8 possibilities.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A room code is exactly this many characters over {@link CODE_ALPHABET}. */
export const CODE_LENGTH = 6;

/**
 * True when `ch` is a single character the alphabet admits, AFTER upper-casing. The segment input
 * upper-cases first (`a` is a legal `A`), so the check is on the normalised form — a lower-case letter
 * that upper-cases into the alphabet is accepted, one that does not (`o`→`O`, excluded) is rejected.
 */
export function isRoomCodeChar(ch: string): boolean {
	return ch.length === 1 && CODE_ALPHABET.includes(ch.toUpperCase());
}

/**
 * Keep only the characters the alphabet admits, upper-cased, capped at {@link CODE_LENGTH}. This is
 * what a paste into a segment box runs through: a pasted `abcd23` becomes `ABCD23`, and a pasted
 * `AB-CD-23` or `abc def` drops the punctuation and spaces rather than refusing the whole paste.
 * Returns at most six characters so a long paste cannot overflow the segment group.
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
