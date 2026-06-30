// M7-C9: shared key-shift helpers — clamp + the keyed MediaStore ref the TV resolves.
import { test, expect } from 'bun:test';
import { clampKeyShift, keyedMediaRef, MAX_KEY_SHIFT } from './types';

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

test('keyedMediaRef: 0 → original; ±N → signed variant before the extension', () => {
  expect(keyedMediaRef('stems/m1-instrumental.wav', 0)).toBe('stems/m1-instrumental.wav');
  expect(keyedMediaRef('stems/m1-instrumental.wav', 2)).toBe('stems/m1-instrumental.+2.wav');
  expect(keyedMediaRef('stems/m1-instrumental.wav', -3)).toBe('stems/m1-instrumental.-3.wav');
});

test('keyedMediaRef clamps the shift like clampKeyShift', () => {
  expect(keyedMediaRef('a/b.wav', 99)).toBe(`a/b.+${MAX_KEY_SHIFT}.wav`);
  expect(keyedMediaRef('a/b.wav', -99)).toBe(`a/b.-${MAX_KEY_SHIFT}.wav`);
});

test('keyedMediaRef leaves an extensionless / non-file ref unchanged', () => {
  expect(keyedMediaRef('dQw4w9WgXcQ', 2)).toBe('dQw4w9WgXcQ'); // a youtube id — no extension
  expect(keyedMediaRef('noext', 2)).toBe('noext');
});

test('keyedMediaRef round-trips through a path with multiple dots (only the last is the ext)', () => {
  expect(keyedMediaRef('stems/my.song.wav', 1)).toBe('stems/my.song.+1.wav');
});
