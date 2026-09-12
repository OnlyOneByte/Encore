// Shared key-shift helper — the clamp on the ±semitone range a singer can ask for.
//
// `keyedMediaRef` used to live beside this and is deliberately gone: transposition happens in the
// browser now, so there is no pre-rendered per-key file to name. See the note in its place in types.ts.
import { test, expect } from 'bun:test';
import { clampKeyShift, MAX_KEY_SHIFT } from '$shared';

test('clampKeyShift bounds to ±MAX_KEY_SHIFT and truncates to an integer', () => {
	expect(clampKeyShift(0)).toBe(0);
	expect(clampKeyShift(3)).toBe(3);
	expect(clampKeyShift(99)).toBe(MAX_KEY_SHIFT);
	expect(clampKeyShift(-99)).toBe(-MAX_KEY_SHIFT);
	expect(clampKeyShift(2.9)).toBe(2); // trunc toward zero
	expect(clampKeyShift(-2.9)).toBe(-2);
	// non-finite → safe default 0 (never a wild transpose)
	expect(clampKeyShift(NaN)).toBe(0);
	expect(clampKeyShift(Infinity)).toBe(0);
	expect(clampKeyShift(-Infinity)).toBe(0);
});
