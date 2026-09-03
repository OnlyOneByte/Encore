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

// ── B-3-C6: honesty about auto-transcribed words ──────────────────────────────
// Force-aligned ASR renders a PERFECT bouncing ball over words that may be wrong — the most
// misleading state the overlay can be in. The notice exists because the result looks finished.
import { lyricsNotice, isAutoTranscribed, type LyricsProvenance } from './lyrics';

const prov = (over: Partial<LyricsProvenance> = {}): LyricsProvenance => ({
	textSource: 'lrclib',
	textConfidence: 'high',
	timing: 'word',
	...over
});

test('authoritative text gets NO notice', () => {
	expect(lyricsNotice(prov())).toBeNull();
	expect(lyricsNotice(prov({ textSource: 'manual' }))).toBeNull();
	expect(isAutoTranscribed(prov())).toBe(false);
});

test('ASR text is labelled, even with word timings that look perfect', () => {
	const p = prov({ textSource: 'asr', textConfidence: 'low', timing: 'word' });
	expect(lyricsNotice(p)).toContain('auto-transcribed');
	expect(isAutoTranscribed(p)).toBe(true);
});

test('a LOW-confidence caption track is labelled too (ASR wearing a caption hat)', () => {
	const p = prov({ textSource: 'captions', textConfidence: 'low' });
	expect(isAutoTranscribed(p)).toBe(true);
});

test('a real human caption track is not labelled', () => {
	expect(isAutoTranscribed(prov({ textSource: 'captions', textConfidence: 'high' }))).toBe(false);
});

test('UNKNOWN provenance says nothing — never claims verified OR guessed', () => {
	expect(lyricsNotice(null)).toBeNull();
	expect(lyricsNotice(undefined)).toBeNull();
	expect(isAutoTranscribed(null)).toBe(false);
});

test('coarse LINE timing alone is not labelled (visible on its own)', () => {
	expect(lyricsNotice(prov({ timing: 'line' }))).toBeNull();
});

// ── pause-based line splitting (whisper segments are not lyric lines) ──────────
import { resegmentLine, parseLyricsDoc as parseDoc, LINE_GAP_SEC, LINE_MAX_CHARS } from './lyrics';

/** words with an explicit gap before each one (seconds) */
function wordsWithGaps(spec: Array<[string, number]>) {
	let t = 0;
	return spec.map(([word, gapBefore]) => {
		t += gapBefore;
		const w = { word, start: t, end: t + 0.25 };
		t += 0.25;
		return w;
	});
}

test('THE BUG: one whisper segment of four lyric lines splits at its pauses', () => {
	// the real Creep segment, abbreviated: pauses between lyric lines, none inside them
	const words = wordsWithGaps([
		['So', 0], ['fucking', 0.05], ['special', 0.05],
		['I', 0.9], ['wish', 0.05], ['I', 0.05], ['was', 0.05], ['special', 0.05],
		['But', 0.9], ["I'm", 0.05], ['a', 0.05], ['creep', 0.05]
	]);
	const line = { start: 0, end: 99, text: words.map((w) => w.word).join(' '), words };
	const out = resegmentLine(line);
	expect(out).toHaveLength(3);
	expect(out[0]!.text).toBe('So fucking special');
	expect(out[1]!.text).toBe('I wish I was special');
	expect(out[2]!.text).toBe("But I'm a creep");
});

test('each split line gets bounds from its OWN words', () => {
	const words = wordsWithGaps([['a', 0], ['b', 0.05], ['c', 1.0], ['d', 0.05]]);
	const out = resegmentLine({ start: 0, end: 99, text: 'a b c d', words });
	expect(out).toHaveLength(2);
	expect(out[0]!.start).toBe(words[0]!.start);
	expect(out[0]!.end).toBe(words[1]!.end);
	expect(out[1]!.start).toBe(words[2]!.start);
});

test('a long pause-free run is split on length so it never wraps to three rows', () => {
	const words = wordsWithGaps(Array.from({ length: 20 }, (_, i) => [`word${i}`, 0.02] as [string, number]));
	const out = resegmentLine({ start: 0, end: 99, text: words.map((w) => w.word).join(' '), words });
	expect(out.length).toBeGreaterThan(1);
	for (const l of out) expect(l.text.length).toBeLessThanOrEqual(LINE_MAX_CHARS + 12);
});

test('a normal short line is left alone', () => {
	const words = wordsWithGaps([['hello', 0], ['world', 0.05]]);
	const out = resegmentLine({ start: 0, end: 1, text: 'hello world', words });
	expect(out).toHaveLength(1);
});

test('REFUSES to split when timed words do not cover the text (would delete lyrics)', () => {
	// the aligner timed only 2 of ~10 words; rebuilding from words[] would drop the rest
	const words = wordsWithGaps([['So', 0], ['special', 1.0]]);
	const line = { start: 0, end: 9, text: 'So fucking special I wish I was special but', words };
	expect(resegmentLine(line)).toEqual([line]);
});

test('a line with no words (line-sync floor) is untouched', () => {
	const line = { start: 0, end: 4, text: 'whole line only', words: [] };
	expect(resegmentLine(line)).toEqual([line]);
});

test('parseLyricsDoc applies resegmentation, so existing artifacts benefit with no re-cook', () => {
	const words = wordsWithGaps([['a', 0], ['b', 0.02], ['c', 1.2], ['d', 0.02]]);
	const doc = parseDoc({ language: 'en', lines: [{ start: 0, end: 9, text: 'a b c d', words }] });
	expect(doc!.lines).toHaveLength(2);
	expect(doc!.words).toHaveLength(4); // the flat word list is unaffected
});

test('the gap threshold is a tunable that behaves monotonically', () => {
	// PAIRS, not single words: a lone word would be folded away by the orphan rule, masking the gap
	// behaviour this is checking.
	const words = wordsWithGaps([
		['aa', 0], ['bb', 0.02],
		['cc', 0.5], ['dd', 0.02],
		['ee', 0.5], ['ff', 0.02]
	]);
	const line = { start: 0, end: 9, text: words.map((w) => w.word).join(' '), words };
	expect(resegmentLine(line, 0.4)).toHaveLength(3); // every 0.5s gap counts
	expect(resegmentLine(line, 2.0)).toHaveLength(1); // none do
	expect(LINE_GAP_SEC).toBeGreaterThan(0);
});

// ── orphan single-word lines ───────────────────────────────────────────────────
// Splitting on pauses alone produced rows holding one word for under a second ("here", "I" in the
// live Creep overlay) — too fast to read and a wasted row of the reel.
import { ORPHAN_MAX_SEC } from './lyrics';

/** Build a line from [word, startSec, endSec] triples. */
function lineOf(spec: Array<[string, number, number]>) {
	const words = spec.map(([word, start, end]) => ({ word, start, end }));
	return { start: words[0]!.start, end: words[words.length - 1]!.end, text: words.map((w) => w.word).join(' '), words };
}

test('a trailing orphan merges BACK into the phrase it belongs to ("...belong | here")', () => {
	// "don't belong" then a tiny gap, "here", then a LONG pause before the next phrase
	const line = lineOf([["don't", 0, 0.4], ['belong', 0.45, 0.8], ['here', 1.4, 1.7], ['I', 4.0, 4.2], ['still', 4.25, 4.5], ['care', 4.55, 4.9]]);
	const out = resegmentLine(line);
	expect(out.map((l) => l.text)).toEqual(["don't belong here", 'I still care']);
});

test('a leading orphan merges FORWARD ("I | want a perfect body")', () => {
	// a real phrase, a long pause, then "I" immediately followed by its own phrase
	const line = lineOf([
		['have', 0, 0.4], ['control', 0.45, 0.9],
		['I', 3.0, 3.15], ['want', 3.2, 3.5], ['a', 3.55, 3.65], ['body', 3.7, 4.0]
	]);
	const out = resegmentLine(line);
	expect(out.map((l) => l.text)).toEqual(['have control', 'I want a body']);
	// NOT "have control I", which is what always-merge-backwards would have produced
	expect(out[0]!.text).not.toContain('I');
});

test('a one-word line that holds the screen long enough KEEPS its own line', () => {
	// a held note: "Yeah" alone for 2s is a real lyric line
	const line = lineOf([['Yeah', 0, 1.9], ['So', 2.6, 2.9], ['special', 2.95, 3.3]]);
	const out = resegmentLine(line);
	expect(out.map((l) => l.text)).toEqual(['Yeah', 'So special']);
	expect(ORPHAN_MAX_SEC).toBe(1.0);
});

test('a multi-word short line is never treated as an orphan', () => {
	const line = lineOf([['oh', 0, 0.2], ['no', 0.22, 0.4], ['So', 1.5, 1.8], ['special', 1.85, 2.2]]);
	const out = resegmentLine(line);
	expect(out.map((l) => l.text)).toEqual(['oh no', 'So special']);
});

// ── the lead offset ────────────────────────────────────────────────────────────
import { LYRICS_LEAD_SEC } from './lyrics';

test('the lead is a positive, sane number of seconds', () => {
	// a full second would highlight the wrong line; zero reads as perpetually behind
	expect(LYRICS_LEAD_SEC).toBeGreaterThan(0);
	expect(LYRICS_LEAD_SEC).toBeLessThan(1);
});

test('leading the position selects the NEXT word sooner (what the knob is for)', () => {
	const line = lineOf([['one', 0, 0.5], ['two', 0.5, 1.0], ['three', 1.0, 1.5]]);
	// at 0.45s the audio is still on "one"; with the lead applied the cue has moved to "two"
	expect(activeWordIndex(line, 0.45)).toBe(0);
	expect(activeWordIndex(line, 0.45 + LYRICS_LEAD_SEC)).toBe(1);
});
