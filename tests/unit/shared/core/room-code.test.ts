// Pins the shared room-code vocabulary. The whole reason this module exists is that the phone's
// six-segment entry and the server's minting/validation now read ONE alphabet, so these assertions are
// what stops the two ends from drifting — and each targets a single production hunk so a revert reds
// exactly one test (per-hunk proof discipline).
import { test, expect } from 'bun:test';
import {
	CODE_ALPHABET,
	CODE_LENGTH,
	isRoomCodeChar,
	normalizeRoomCodeInput,
	CODE_EXCLUDED_NOTE
} from '$shared';

test('CODE_ALPHABET is exactly the confusable-free set, and CODE_LENGTH is six', () => {
	// The literal itself — a revert to any other alphabet reds here, which is what keeps the phone's
	// rejection identical to the server's.
	expect(CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789');
	expect(CODE_LENGTH).toBe(6);
	// The confusable characters are ABSENT by construction, stated as a property so a future edit that
	// re-adds one is caught by meaning, not just by the literal.
	for (const banned of ['O', 'I', 'L', '0', '1']) {
		expect(CODE_ALPHABET.includes(banned)).toBe(false);
	}
	// 31 symbols: 23 letters (26 minus O/I/L) + 8 digits (10 minus 0/1). Measured, not eyeballed.
	expect(CODE_ALPHABET.length).toBe(31);
});

test('isRoomCodeChar admits alphabet characters after upper-casing, rejects the excluded and the non-single', () => {
	expect(isRoomCodeChar('A')).toBe(true);
	expect(isRoomCodeChar('a')).toBe(true); // upper-cases into A
	expect(isRoomCodeChar('2')).toBe(true);
	// The whole point of the restriction: an excluded character is refused even though it is a letter.
	expect(isRoomCodeChar('O')).toBe(false);
	expect(isRoomCodeChar('o')).toBe(false); // o -> O, excluded
	expect(isRoomCodeChar('l')).toBe(false);
	expect(isRoomCodeChar('1')).toBe(false);
	expect(isRoomCodeChar('0')).toBe(false);
	expect(isRoomCodeChar('-')).toBe(false);
	expect(isRoomCodeChar('')).toBe(false);
	expect(isRoomCodeChar('AB')).toBe(false); // not a single character
});

test('normalizeRoomCodeInput keeps only admitted characters, upper-cases, and caps at CODE_LENGTH', () => {
	expect(normalizeRoomCodeInput('abcd23')).toBe('ABCD23');
	// Punctuation and spaces are dropped rather than refusing the whole paste.
	expect(normalizeRoomCodeInput('AB-CD 23')).toBe('ABCD23');
	// Excluded characters are dropped, not substituted.
	expect(normalizeRoomCodeInput('AOBI0L')).toBe('AB'); // O,I,0,L all dropped
	// A long paste cannot overflow the six segments.
	expect(normalizeRoomCodeInput('ABCDEFGHJK')).toBe('ABCDEF');
	expect(normalizeRoomCodeInput('ABCDEFGHJK').length).toBe(CODE_LENGTH);
	expect(normalizeRoomCodeInput('')).toBe('');
});

test('CODE_EXCLUDED_NOTE names the excluded characters for the keystroke message', () => {
	// SC 3.3.1 — the rejection has to SAY why, and name the characters that are barred.
	for (const banned of ['O', 'I', 'L', '0', '1']) {
		expect(CODE_EXCLUDED_NOTE.includes(banned)).toBe(true);
	}
});
