// guard: the alignment BENCH scores what this file's subject lights. Its `highlight` metric (a reject-if for
// alignment changes) reads "which word is lit" through a Python PORT of
// lyrics.ts — parse, pause re-segmentation, orphan folding, activeLineIndex, activeWordIndex — as the overlay's
// word-level branch uses them (docs/benchmarks/forced-alignment/scripts/e2e_lib.py). The fixture beside this test
// is written FROM THE PORT (scripts/tv_parity.py); worker/tests/test_bench_e2e.py asserts the port still writes it,
// and this test asserts lyrics.ts displays the same rows and lights the same word at every position.
//
// So a TV change that moves a row or a lit word (as rendering `low` lines line-level did) is RED here until the
// port changes with it and the fixture is regenerated — never hand-edit the JSON. Otherwise the bench goes on
// scoring a TV the room no longer sees. The one-off cross-check this replaces (0 of 60,000 positions disagreed)
// was never committed, and three port mutations survived the suite.
import { test, expect } from 'bun:test';
import { read } from '$test';
import {
	parseLyricsDoc,
	activeLineIndex,
	activeWordIndex,
	wipesWords,
	wordGap,
	LINE_GAP_SEC,
	LINE_MAX_CHARS,
	ORPHAN_MAX_SEC,
	LYRICS_LEAD_SEC,
	type LyricsDoc
} from '$lib/tv/lyrics';

interface ParityCase {
	name: string;
	doc: unknown;
	/** The rows the TV displays: [text, start, end] after parse + re-segmentation. */
	rows: [string, number | null, number | null][];
	positions: number[];
	/** The flat index (document order) of the word lit at each position, or -1. */
	lit: number[];
}

interface Parity {
	constants: { line_gap_sec: number; line_max_chars: number; orphan_max_sec: number; lyrics_lead_sec: number };
	overlay_word_branch: string;
	cases: ParityCase[];
}

const fixture = JSON.parse(read('tests/unit/lib/tv/bench-highlight-parity.json')) as Parity;

/** What the overlay lights at `pos`: the active line's active word, as a flat index into `doc.words`.
 *  `wipesWords` is part of it — a `low` row renders as one text node and lights nothing — and the
 *  port's `tv_lit(wipe_low=True)` is what this mirrors. Without it the two trees would agree only on
 *  documents that carry no grade. */
function litAt(doc: LyricsDoc, pos: number): number {
	const line = activeLineIndex(doc.lines, pos);
	if (line < 0) return -1;
	const row = doc.lines[line]!;
	if (!wipesWords(row)) return -1;
	const word = activeWordIndex(row, pos);
	// Re-segmentation keeps the parsed word OBJECTS, so identity finds each word's place in the flat list.
	return word < 0 ? -1 : doc.words.indexOf(row.words[word]!);
}

test('the bench fixture covers every rule the port models', () => {
	const names = fixture.cases.map((c) => c.name);
	for (const shape of [
		'misbound-late',
		'orphan-merges-back',
		'orphan-merges-forward-after-a-row',
		'coverage-refusal',
		'char-cap-without-a-pause',
		'overlapping-and-reversed-words',
		// The low-line rule, its carry across a split, and the three grades that keep the wipe.
		'low-line-lights-no-word',
		'low-line-splits-and-no-row-wipes',
		'other-grades-still-wipe',
		// The CJK word gap, the one rule the two trees can now disagree about.
		'cjk-rebuilt-without-spaces',
		'cjk-splits-at-a-pause'
	])
		expect(names).toContain(shape);
	expect(fixture.cases.reduce((n, c) => n + c.positions.length, 0)).toBeGreaterThan(1000);
});

test('the port joins the same codepoints this file does, enumerated', () => {
	// The port cannot WRITE this file's class — Python's `re` has no Script_Extensions — so it carries a frozen
	// copy, and only a one-off enumeration ever said the two were equal. This is that
	// enumeration as a gate: a Unicode release that adds a Han codepoint moves `\p{scx=...}` here and not the
	// copy there, and the two parity cases below exercise far too few characters to notice.
	//
	// `wordGap` rather than the class itself, so what is pinned is the rule the room runs: a pair of the SAME
	// character joins with no space exactly where that character is one of the joiners.
	const frozen = JSON.parse(read('tests/unit/lib/tv/cjk-join-ranges.json')) as {
		codepoints: number;
		ranges: [number, number][];
	};
	const pair = [{ word: '' }, { word: '' }];
	const joins = (code: number): boolean => {
		const ch = String.fromCodePoint(code);
		pair[0]!.word = ch;
		pair[1]!.word = ch;
		return wordGap(pair, 0) === '';
	};
	const ours: [number, number][] = [];
	for (let code = 0; code < 0x110000; code++) {
		if (!joins(code)) continue;
		const last = ours.at(-1);
		if (last && last[1] === code - 1) last[1] = code;
		else ours.push([code, code]);
	}
	expect(ours).toEqual(frozen.ranges);
	expect(ours.reduce((n, [lo, hi]) => n + hi - lo + 1, 0)).toBe(frozen.codepoints);
});

test("the port's constants are this file's", () => {
	expect(fixture.constants).toEqual({
		line_gap_sec: LINE_GAP_SEC,
		line_max_chars: LINE_MAX_CHARS,
		orphan_max_sec: ORPHAN_MAX_SEC,
		lyrics_lead_sec: LYRICS_LEAD_SEC
	});
});

test('the overlay lights words only in the branch the port models', () => {
	// The port lights the active word of the active line under the `word` setting AND the per-line
	// `wipesWords` grade. A new condition here is a change the port must make too.
	expect(read('src/lib/tv/LyricsOverlay.svelte')).toContain(fixture.overlay_word_branch);
	expect(fixture.overlay_word_branch).toContain('wipesWords(l)');
});

for (const c of fixture.cases) {
	test(`lyrics.ts displays and lights what the bench port does: ${c.name}`, () => {
		const doc = parseLyricsDoc(c.doc)!;
		expect(doc).not.toBeNull();
		expect(doc.lines.map((l) => [l.text, l.start, l.end])).toEqual(c.rows);
		expect(c.positions.map((pos) => litAt(doc, pos))).toEqual(c.lit);
	});
}
