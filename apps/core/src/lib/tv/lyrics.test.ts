// M8-C2: pure karaoke-timing logic — parse untrusted artifacts + resolve the active line/word and
// per-word fill at a playback position. This is the testable core behind the eyes-on TV overlay.
import { test, expect } from 'bun:test';
import {
	parseLyricsDoc,
	lineBounds,
	activeLineIndex,
	activeWordIndex,
	wordFill,
	type LyricsDoc
} from './lyrics';

// mirrors the worker's normalize_lyrics output (M7-C8)
const raw = {
	language: 'en',
	lines: [
		{
			start: 0.0,
			end: 1.0,
			text: 'the quick fox',
			words: [
				{ word: 'the', start: 0.0, end: 0.3 },
				{ word: 'quick', start: 0.3, end: 0.6 },
				{ word: 'fox', start: 0.6, end: 1.0 }
			]
		},
		{
			start: 2.0,
			end: 3.0,
			text: 'jumps over',
			words: [
				{ word: 'jumps', start: 2.0, end: 2.5 },
				{ word: 'over', start: 2.5, end: 3.0 }
			]
		}
	]
};

test('parseLyricsDoc: valid artifact → typed doc with flattened words', () => {
	const doc = parseLyricsDoc(raw)!;
	expect(doc.language).toBe('en');
	expect(doc.lines).toHaveLength(2);
	expect(doc.words).toHaveLength(5);
	expect(doc.lines[0].words[1].word).toBe('quick');
});

test('parseLyricsDoc: untrusted junk is dropped, empty → null', () => {
	expect(parseLyricsDoc(null)).toBeNull();
	expect(parseLyricsDoc({ lines: [] })).toBeNull();
	expect(parseLyricsDoc('nope')).toBeNull();
	// a word with NaN/missing bounds is dropped; a line with no text and no words vanishes
	const doc = parseLyricsDoc({
		lines: [
			{ text: '', words: [{ word: 'x', start: NaN, end: 1 }] },
			{ text: 'ok', words: [{ word: 'ok', start: 0.1, end: 0.4 }] }
		]
	});
	expect(doc).not.toBeNull();
	expect(doc!.lines).toHaveLength(1);
	expect(doc!.lines[0].text).toBe('ok');
});

test('parseLyricsDoc: derives line text from words when segment text is absent', () => {
	const doc = parseLyricsDoc({
		lines: [{ words: [{ word: 'la', start: 0, end: 0.5 }, { word: 'la', start: 0.5, end: 1 }] }]
	})!;
	expect(doc.lines[0].text).toBe('la la');
});

test('lineBounds: falls back to word bounds when segment bounds missing', () => {
	expect(lineBounds({ start: 1, end: 2, text: 'x', words: [] })).toEqual([1, 2]);
	expect(
		lineBounds({ start: null, end: null, text: 'x', words: [{ word: 'a', start: 3, end: 4 }, { word: 'b', start: 4, end: 5 }] })
	).toEqual([3, 5]);
	expect(lineBounds({ start: null, end: null, text: 'x', words: [] })).toBeNull();
});

test('activeLineIndex: currently-sung line, gap holds last line, pre-roll shows first', () => {
	const doc = parseLyricsDoc(raw)! as LyricsDoc;
	expect(activeLineIndex(doc.lines, -0.5)).toBe(0); // before start → first line
	expect(activeLineIndex(doc.lines, 0.5)).toBe(0); // singing line 0
	expect(activeLineIndex(doc.lines, 1.5)).toBe(0); // gap after line 0 → stays lit
	expect(activeLineIndex(doc.lines, 2.2)).toBe(1); // singing line 1
	expect(activeLineIndex(doc.lines, 9.0)).toBe(1); // after the end → last line
	expect(activeLineIndex([], 1)).toBe(-1);
});

test('activeWordIndex: the "ball" sits on the word being sung, -1 between words', () => {
	const line = parseLyricsDoc(raw)!.lines[0];
	expect(activeWordIndex(line, 0.1)).toBe(0); // "the"
	expect(activeWordIndex(line, 0.45)).toBe(1); // "quick"
	expect(activeWordIndex(line, 0.8)).toBe(2); // "fox"
	expect(activeWordIndex(line, 5)).toBe(-1); // past the line
});

test('wordFill: 0 before, linear during, 1 after; zero-length snaps to 1', () => {
	const w = { word: 'quick', start: 0.3, end: 0.6 };
	expect(wordFill(w, 0.2)).toBe(0);
	expect(wordFill(w, 0.45)).toBeCloseTo(0.5, 5);
	expect(wordFill(w, 0.7)).toBe(1);
	expect(wordFill({ word: 'z', start: 1, end: 1 }, 1)).toBe(1); // degenerate
});
