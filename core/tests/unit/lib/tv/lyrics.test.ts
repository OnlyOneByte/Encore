// pure karaoke-timing logic — parse untrusted artifacts + resolve the active line/word and
// per-word fill at a playback position. This is the testable core behind the eyes-on TV overlay.
import { test, expect } from 'bun:test';
import {
	parseLyricsDoc,
	lineBounds,
	activeLineIndex,
	activeWordIndex,
	wipesWords,
	type LyricsDoc
} from '$lib/tv/lyrics';
// `resegmentLine` is imported ONCE, in the second import block below, beside the LINE_GAP_SEC /
// LINE_MAX_CHARS constants its tests read — naming it here as well is a duplicate binding that tsc
// rejects even though the bundler tolerates it, so the split-testing block owns the name.

// Mirrors the worker's normalize_lyrics output.
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
	// A word with NaN or missing bounds is dropped; a line with no text and no words vanishes.
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
		lines: [
			{
				words: [
					{ word: 'la', start: 0, end: 0.5 },
					{ word: 'la', start: 0.5, end: 1 }
				]
			}
		]
	})!;
	expect(doc.lines[0].text).toBe('la la');
});

test('lineBounds: falls back to word bounds when segment bounds missing', () => {
	expect(lineBounds({ start: 1, end: 2, text: 'x', words: [] })).toEqual([1, 2]);
	expect(
		lineBounds({
			start: null,
			end: null,
			text: 'x',
			words: [
				{ word: 'a', start: 3, end: 4 },
				{ word: 'b', start: 4, end: 5 }
			]
		})
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

// Force-aligned ASR renders a PERFECT bouncing ball over words that may be wrong, which is the most
// misleading state the overlay can be in: the notice exists because the result LOOKS finished.
import { isAutoTranscribed, provenanceLabel, type LyricsProvenance } from '$lib/tv/lyrics';

const prov = (over: Partial<LyricsProvenance> = {}): LyricsProvenance => ({
	textSource: 'lrclib',
	textConfidence: 'high',
	timing: 'word',
	...over
});

test('authoritative text gets NO notice', () => {
	expect(isAutoTranscribed(prov())).toBe(false);
});

test('ASR text is labelled, even with word timings that look perfect', () => {
	const p = prov({ textSource: 'asr', textConfidence: 'low', timing: 'word' });
	expect(isAutoTranscribed(p)).toBe(true);
});

test('a LOW-confidence caption track is labelled too (ASR wearing a caption hat)', () => {
	const p = prov({ textSource: 'captions', textConfidence: 'low' });
	expect(isAutoTranscribed(p)).toBe(true);
});

test('a real human caption track is not labelled', () => {
	expect(isAutoTranscribed(prov({ textSource: 'captions', textConfidence: 'high' }))).toBe(false);
});

// The worker's wrong-text gate rides on `vouched`, not on `textConfidence` (W3 review r2), so the overlay's
// "not verified" treatment has to read it: the same hand-authored track, doubted, still says "Captions" but
// must not render as verified.
test('a caption track no wrong-text gate vouched for IS labelled, and keeps its provenance', () => {
	const doubted = prov({ textSource: 'captions', textConfidence: 'high', vouched: false });
	expect(isAutoTranscribed(doubted)).toBe(true);
	expect(provenanceLabel(doubted)).toBe(provenanceLabel(prov({ textSource: 'captions' })));
});

test('UNKNOWN provenance says nothing — never claims verified OR guessed', () => {
	expect(isAutoTranscribed(null)).toBe(false);
});

test('coarse LINE timing alone is not flagged unverified when text is authoritative', () => {
	expect(isAutoTranscribed(prov({ timing: 'line' }))).toBe(false);
});

// The provenance tag is a SOURCE label, never a confidence or quality score. It must name the source for
// every kind and stay silent when provenance is unknown. Each arm asserts a DISTINCT string, so a map
// that folds two sources onto one label reds.
test('LRCLIB / authored record is named', () => {
	expect(provenanceLabel(prov({ textSource: 'lrclib' }))).toBe('LRCLIB');
});

test('a caption track is named as the video captions', () => {
	expect(provenanceLabel(prov({ textSource: 'captions' }))).toBe('From the video captions');
});

test('ASR is named auto-transcribed', () => {
	expect(provenanceLabel(prov({ textSource: 'asr', textConfidence: 'low' }))).toBe('Auto-transcribed');
});

test('hand-pasted text is named as pasted by hand', () => {
	expect(provenanceLabel(prov({ textSource: 'manual' }))).toBe('Pasted by hand');
});

test('UNKNOWN provenance (pre-candidate artifact) renders NO tag -- not "unknown"', () => {
	expect(provenanceLabel(null)).toBeNull();
	expect(provenanceLabel(undefined)).toBeNull();
});

test('every source kind gets a DISTINCT, non-empty label -- none collide', () => {
	const kinds = ['lrclib', 'captions', 'asr', 'manual'] as const;
	const labels = kinds.map((k) => provenanceLabel(prov({ textSource: k })));
	for (const l of labels) expect(typeof l === 'string' && l.length > 0).toBe(true);
	expect(new Set(labels).size).toBe(kinds.length);
});

// Pause-based line splitting: whisper segments are not lyric lines.
import {
	resegmentLine,
	parseLyricsDoc as parseDoc,
	LINE_GAP_SEC,
	LINE_MAX_CHARS,
	type LyricLine
} from '$lib/tv/lyrics';

/**
 * `resegmentLine` with the length guard OFF (`splitAboveChars: 0`): these are about WHERE it breaks once it has decided
 * to break, so they use short synthetic lines rather than padding every fixture past 42 chars. The decision itself is
 * covered by the length-guard test.
 */
const resegmentAnyLength = (line: LyricLine, gapSec: number = LINE_GAP_SEC) =>
	resegmentLine(line, gapSec, LINE_MAX_CHARS, 0);

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
	// A real segment, abbreviated: pauses between lyric lines, none inside them.
	const words = wordsWithGaps([
		['So', 0],
		['fucking', 0.05],
		['special', 0.05],
		['I', 0.9],
		['wish', 0.05],
		['I', 0.05],
		['was', 0.05],
		['special', 0.05],
		['But', 0.9],
		["I'm", 0.05],
		['a', 0.05],
		['creep', 0.05]
	]);
	const line = { start: 0, end: 99, text: words.map((w) => w.word).join(' '), words };
	const out = resegmentLine(line);
	expect(out).toHaveLength(3);
	expect(out[0]!.text).toBe('So fucking special');
	expect(out[1]!.text).toBe('I wish I was special');
	expect(out[2]!.text).toBe("But I'm a creep");
});

test('each split line gets bounds from its OWN words', () => {
	const words = wordsWithGaps([
		['a', 0],
		['b', 0.05],
		['c', 1.0],
		['d', 0.05]
	]);
	const out = resegmentAnyLength({ start: 0, end: 99, text: 'a b c d', words });
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
	const words = wordsWithGaps([
		['hello', 0],
		['world', 0.05]
	]);
	const out = resegmentLine({ start: 0, end: 1, text: 'hello world', words });
	expect(out).toHaveLength(1);
});

test('REFUSES to split when timed words do not cover the text (would delete lyrics)', () => {
	// The aligner timed only 2 of ~10 words, so rebuilding from words[] would drop the rest.
	const words = wordsWithGaps([
		['So', 0],
		['special', 1.0]
	]);
	const line = { start: 0, end: 9, text: 'So fucking special I wish I was special but', words };
	expect(resegmentLine(line)).toEqual([line]);
});

test('a line with no words (line-sync floor) is untouched', () => {
	const line = { start: 0, end: 4, text: 'whole line only', words: [] };
	expect(resegmentLine(line)).toEqual([line]);
});

test('parseLyricsDoc applies resegmentation, so existing artifacts benefit with no re-process', () => {
	// Over-long ON PURPOSE (64 chars): production only resegments a line that exceeds a row, so a shorter
	// fixture would stop exercising the wiring.
	const words = wordsWithGaps([
		['walking', 0],
		['down', 0.02],
		['the', 0.02],
		['harbour', 0.02],
		['road', 0.02],
		['alone', 0.02],
		['watching', 1.2],
		['all', 0.02],
		['the', 0.02],
		['lights', 0.02],
		['go', 0.02],
		['out', 0.02]
	]);
	const text = words.map((w) => w.word).join(' ');
	const doc = parseDoc({ language: 'en', lines: [{ start: 0, end: 9, text, words }] });
	expect(text.length).toBeGreaterThan(LINE_MAX_CHARS);
	expect(doc!.lines).toHaveLength(2);
	expect(doc!.words).toHaveLength(12); // the flat word list is unaffected
});

test('the length guard: a line that already FITS a row is never resegmented', () => {
	// A pause inside a SHORT line is a breath or a held note, not a line break — splitting on it produces
	// rows that flash past mid-phrase. Blobs are re-lineated in the worker, where the provenance to know
	// the text came from ASR lives, so this function is a safety net for over-long lines only.
	const words = wordsWithGaps([
		['hold', 0],
		['on', 0.02],
		['tight', 2.0],
		['now', 0.02]
	]);
	const line = { start: 0, end: 9, text: 'hold on tight now', words };
	expect(line.text.length).toBeLessThanOrEqual(LINE_MAX_CHARS);
	expect(resegmentLine(line)).toEqual([line]); // left alone despite a 2s gap in the middle
	expect(resegmentAnyLength(line)).toHaveLength(2); // …and the mechanism itself still works
});

test('the gap threshold is a tunable that behaves monotonically', () => {
	// PAIRS, not single words: a lone word is folded away by the orphan rule, masking the gap behaviour.
	const words = wordsWithGaps([
		['aa', 0],
		['bb', 0.02],
		['cc', 0.5],
		['dd', 0.02],
		['ee', 0.5],
		['ff', 0.02]
	]);
	const line = { start: 0, end: 9, text: words.map((w) => w.word).join(' '), words };
	expect(resegmentAnyLength(line, 0.4)).toHaveLength(3); // every 0.5s gap counts
	expect(resegmentAnyLength(line, 2.0)).toHaveLength(1); // none do
	expect(LINE_GAP_SEC).toBeGreaterThan(0);
});

// Orphan single-word lines. Splitting on pauses alone leaves rows holding one word for under a second:
// too fast to read, and a wasted row of the reel.
import { ORPHAN_MAX_SEC } from '$lib/tv/lyrics';

/** Build a line from [word, startSec, endSec] triples. */
function lineOf(spec: Array<[string, number, number]>) {
	const words = spec.map(([word, start, end]) => ({ word, start, end }));
	return { start: words[0]!.start, end: words[words.length - 1]!.end, text: words.map((w) => w.word).join(' '), words };
}

test('a trailing orphan merges BACK into the phrase it belongs to ("...belong | here")', () => {
	const line = lineOf([
		["don't", 0, 0.4],
		['belong', 0.45, 0.8],
		['here', 1.4, 1.7],
		['I', 4.0, 4.2],
		['still', 4.25, 4.5],
		['care', 4.55, 4.9]
	]);
	const out = resegmentAnyLength(line);
	expect(out.map((l) => l.text)).toEqual(["don't belong here", 'I still care']);
});

test('a leading orphan merges FORWARD ("I | want a perfect body")', () => {
	const line = lineOf([
		['have', 0, 0.4],
		['control', 0.45, 0.9],
		['I', 3.0, 3.15],
		['want', 3.2, 3.5],
		['a', 3.55, 3.65],
		['body', 3.7, 4.0]
	]);
	const out = resegmentAnyLength(line);
	expect(out.map((l) => l.text)).toEqual(['have control', 'I want a body']);
	// NOT "have control I", which always-merge-backwards produces.
	expect(out[0]!.text).not.toContain('I');
});

test('a one-word line that holds the screen long enough KEEPS its own line', () => {
	// A held note: "Yeah" alone for 2s is a real lyric line.
	const line = lineOf([
		['Yeah', 0, 1.9],
		['So', 2.6, 2.9],
		['special', 2.95, 3.3]
	]);
	const out = resegmentAnyLength(line);
	expect(out.map((l) => l.text)).toEqual(['Yeah', 'So special']);
	expect(ORPHAN_MAX_SEC).toBe(1.0);
});

test('a multi-word short line is never treated as an orphan', () => {
	const line = lineOf([
		['oh', 0, 0.2],
		['no', 0.22, 0.4],
		['So', 1.5, 1.8],
		['special', 1.85, 2.2]
	]);
	const out = resegmentAnyLength(line);
	expect(out.map((l) => l.text)).toEqual(['oh no', 'So special']);
});

import { LYRICS_LEAD_SEC } from '$lib/tv/lyrics';

test('the default lead is 0 — the global lead is opt-in per room', () => {
	// A single global lead is a band-aid, so it ships OFF and the per-room `lyricsLeadMs` is the opt-in. A
	// hard literal, not `.toBe(SOME_CONST)`, so this pins the value rather than re-reading the constant.
	expect(LYRICS_LEAD_SEC).toBe(0);
});

test('a lead selects the NEXT word sooner (what the knob is for)', () => {
	const line = lineOf([
		['one', 0, 0.5],
		['two', 0.5, 1.0],
		['three', 1.0, 1.5]
	]);
	// At 0.45s the audio is still on "one" and an explicit 0.3s lead moves the cue to "two". A literal
	// lead, not LYRICS_LEAD_SEC, so this keeps proving the knob works whatever the default becomes.
	const lead = 0.3;
	expect(activeWordIndex(line, 0.45)).toBe(0);
	expect(activeWordIndex(line, 0.45 + lead)).toBe(1);
});

// Dual-script pass-through: a line-synced doc can carry a per-line `romanization`, which parseLyricsDoc
// surfaces onto the line and leaves undefined otherwise. Display-only — it carries no timings.
test('parseLyricsDoc surfaces per-line romanization when the doc carries it', () => {
	const doc = parseLyricsDoc({
		language: 'zh',
		lines: [
			{ start: 0, end: 2, text: '真情像草原广阔', words: [], romanization: 'zhēn qíng xiàng cǎo yuán guǎng kuò' },
			{ start: 2, end: 4, text: 'a line with no second script', words: [] }
		],
		words: []
	});
	expect(doc).not.toBeNull();
	expect(doc!.lines[0]!.romanization).toBe('zhēn qíng xiàng cǎo yuán guǎng kuò');
	expect(doc!.lines[1]!.romanization).toBeUndefined();
});

test('parseLyricsDoc ignores a blank/non-string romanization (if-available, never fabricated)', () => {
	const doc = parseLyricsDoc({
		language: 'zh',
		lines: [
			{ start: 0, end: 2, text: '中文歌词', words: [], romanization: '   ' },
			{ start: 2, end: 4, text: '更多歌词', words: [], romanization: 42 }
		],
		words: []
	});
	expect(doc).not.toBeNull();
	expect(doc!.lines[0]!.romanization).toBeUndefined();
	expect(doc!.lines[1]!.romanization).toBeUndefined();
});

// Duet part attribution: the worker's diarization writes a `part` letter on each line of a CONFIDENT duet, and a solo
// or undiarized song carries none. The TV carries it through parse and resegmentation faithfully and NEVER invents one.

test('parseLyricsDoc carries a per-line duet part through, and omits it when absent', () => {
	const doc = parseLyricsDoc({
		language: 'en',
		lines: [
			{ start: 0, end: 1, text: 'my line', words: [{ word: 'my', start: 0, end: 1 }], part: 'A' },
			{ start: 1, end: 2, text: 'your line', words: [{ word: 'your', start: 1, end: 2 }], part: 'B' },
			{ start: 2, end: 3, text: 'no part', words: [{ word: 'no', start: 2, end: 3 }] }
		],
		words: []
	});
	expect(doc).not.toBeNull();
	expect(doc!.lines.map((l) => l.part)).toEqual(['A', 'B', undefined]);
});

test('parseLyricsDoc ignores a blank/non-string part (if-available, never fabricated)', () => {
	const doc = parseLyricsDoc({
		language: 'en',
		lines: [
			{ start: 0, end: 2, text: 'a', words: [], part: '   ' },
			{ start: 2, end: 4, text: 'b', words: [], part: 7 }
		],
		words: []
	});
	expect(doc).not.toBeNull();
	expect(doc!.lines[0]!.part).toBeUndefined();
	expect(doc!.lines[1]!.part).toBeUndefined();
});

test('resegmenting a long duet line keeps the part on every row it splits into', () => {
	// Every row of a split line must keep its part, or a duet's colour drops on all but the first.
	const words = wordsWithGaps([
		['this', 0],
		['is', 0.05],
		['a', 0.05],
		['fairly', 0.05],
		['long', 0.9],
		['sung', 0.05],
		['duet', 0.05],
		['line', 0.05]
	]);
	const line: LyricLine = {
		start: words[0]!.start,
		end: words[words.length - 1]!.end,
		text: words.map((w) => w.word).join(' '),
		words,
		part: 'B'
	};
	const out = resegmentLine(line, LINE_GAP_SEC, LINE_MAX_CHARS, 0);
	expect(out.length).toBeGreaterThan(1); // it actually split
	expect(out.every((l) => l.part === 'B')).toBe(true);
});

// ── alignment v2's optional fields: syllables on words, confidence on lines ──────────────────────

test('syllables parse when well-formed and malformed entries drop silently', () => {
	const doc = parseLyricsDoc({
		language: 'en',
		lines: [
			{
				text: 'away',
				start: 1,
				end: 2,
				words: [
					{
						word: 'away',
						start: 1,
						end: 2,
						syllables: [
							{ text: 'a', start: 1, end: 1.4 },
							{ text: 'way', start: 1.6, end: 2 },
							{ text: '', start: 1, end: 2 }, // empty text: drop
							{ text: 'x', start: 'no' } // malformed: drop
						]
					}
				]
			}
		]
	});
	expect(doc).not.toBeNull();
	const word = doc!.lines[0]!.words[0]!;
	expect(word.syllables).toEqual([
		{ text: 'a', start: 1, end: 1.4 },
		{ text: 'way', start: 1.6, end: 2 }
	]);
});

test('a v1 document without syllables or confidence parses exactly as before', () => {
	// The compatibility promise: these fields are additive. An old artifact must produce a word with NO
	// syllables key (not an empty array) and a line with NO confidence.
	const doc = parseLyricsDoc({
		language: 'en',
		lines: [{ text: 'hi', start: 0, end: 1, words: [{ word: 'hi', start: 0, end: 1 }] }]
	});
	expect(doc!.lines[0]!.words[0]!.syllables).toBeUndefined();
	expect(doc!.lines[0]!.confidence).toBeUndefined();
});

test('line confidence parses only the three known values', () => {
	const doc = parseLyricsDoc({
		language: 'en',
		lines: [
			{ text: 'a', start: 0, end: 1, words: [{ word: 'a', start: 0, end: 1 }], confidence: 'low' },
			{ text: 'b', start: 2, end: 3, words: [{ word: 'b', start: 2, end: 3 }], confidence: 'shiny' }
		]
	});
	expect(doc!.lines[0]!.confidence).toBe('low');
	expect(doc!.lines[1]!.confidence).toBeUndefined(); // unknown value: dropped, not trusted
});

test('confidence survives a resegment split, like a duet part does', () => {
	// The grading judged the SOURCE line; every row it splits into inherits the judgement.
	const line = {
		start: 0,
		end: 20,
		text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen',
		words: Array.from({ length: 14 }, (_v, i) => ({
			word: [
				'one',
				'two',
				'three',
				'four',
				'five',
				'six',
				'seven',
				'eight',
				'nine',
				'ten',
				'eleven',
				'twelve',
				'thirteen',
				'fourteen'
			][i]!,
			start: i * (i < 7 ? 0.4 : 0.4) + (i >= 7 ? 5 : 0),
			end: i * 0.4 + (i >= 7 ? 5.3 : 0.3)
		})),
		confidence: 'low' as const
	};
	const split = resegmentLine(line, 1.0, 40);
	expect(split.length).toBeGreaterThan(1);
	for (const l of split) expect(l.confidence).toBe('low');
});

// ── W6's consumer: a `low` line renders line-level, so the word wipe is a per-LINE decision ──────
//
// The whole point of grading lines (worker review §3.7): nothing read per-line `confidence`, so the signal
// bought nothing. `wipesWords` is the reader, and `LyricsOverlay.svelte`'s word branch is its only caller.

test('a low line does not wipe words; every other grade does', () => {
	expect(wipesWords({ confidence: 'low' })).toBe(false);
	expect(wipesWords({ confidence: 'high' })).toBe(true);
	// `medium` is a DOCUMENT grade, never a line's, so a rule that doubted it would have no producer.
	expect(wipesWords({ confidence: 'medium' })).toBe(true);
	// The compatibility half: a v1 artifact carries no grade, and a missing field must not read as doubt —
	// that would silently turn the karaoke sweep off for every older document.
	expect(wipesWords({})).toBe(true);
	expect(wipesWords({ confidence: undefined })).toBe(true);
});

test('every row a low line splits into keeps the no-wipe reading', () => {
	// `resegmentLine` carries `confidence` onto each row; `wipesWords` is what that carry is FOR.
	const line = {
		start: 0,
		end: 8,
		text: 'morning light is falling on the rivers and the sea tonight',
		words: 'morning light is falling on the rivers and the sea tonight'.split(' ').map((word, i) => ({
			word,
			start: i * 0.5,
			end: i * 0.5 + 0.4
		})),
		confidence: 'low' as const
	};
	const split = resegmentLine(line);
	expect(split.length).toBeGreaterThan(1);
	expect(split.every((l) => !wipesWords(l))).toBe(true);
});

test('a parsed document carries the grade the wipe rule reads', () => {
	const doc = parseLyricsDoc({
		language: 'en',
		lines: [
			{ text: 'a', start: 0, end: 1, words: [{ word: 'a', start: 0, end: 1 }], confidence: 'low' },
			{ text: 'b', start: 2, end: 3, words: [{ word: 'b', start: 2, end: 3 }] }
		]
	})!;
	expect(doc.lines.map(wipesWords)).toEqual([false, true]);
});
