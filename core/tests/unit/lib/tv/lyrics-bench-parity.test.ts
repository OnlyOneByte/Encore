// guard: the alignment BENCH scores what this file's subject lights. Its `highlight` metric (a reject-if for
// alignment changes: docs/PLAN-alignment-v3.md W4, 6c) reads "which word is lit" through a Python PORT of
// lyrics.ts — parse, pause re-segmentation, orphan folding, activeLineIndex, activeWordIndex — as the overlay's
// word-level branch uses them (docs/benchmarks/forced-alignment/scripts/e2e_lib.py). The fixture beside this test
// is written FROM THE PORT (scripts/tv_parity.py); worker/tests/test_bench_e2e.py asserts the port still writes it,
// and this test asserts lyrics.ts displays the same rows and lights the same word at every position.
//
// So a TV change that moves a row or a lit word (W6 plans `low` lines rendered line-level) is RED here until the
// port changes with it and the fixture is regenerated — never hand-edit the JSON. Otherwise the bench goes on
// scoring a TV the room no longer sees. The one-off cross-check this replaces (0 of 60,000 positions disagreed)
// was never committed, and three port mutations survived the suite (review round 2).
import { test, expect } from 'bun:test';
import { read } from '$test';
import {
	parseLyricsDoc,
	activeLineIndex,
	activeWordIndex,
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

/** What the overlay lights at `pos`: the active line's active word, as a flat index into `doc.words`. */
function litAt(doc: LyricsDoc, pos: number): number {
	const line = activeLineIndex(doc.lines, pos);
	if (line < 0) return -1;
	const row = doc.lines[line]!;
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
		'overlapping-and-reversed-words'
	])
		expect(names).toContain(shape);
	expect(fixture.cases.reduce((n, c) => n + c.positions.length, 0)).toBeGreaterThan(1000);
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
	// The port lights the active word of the active line, always: it models THIS condition with the `word`
	// setting. A new condition here (a `low` line rendered line-level) is a change the port must make too.
	expect(read('src/lib/tv/LyricsOverlay.svelte')).toContain(fixture.overlay_word_branch);
});

for (const c of fixture.cases) {
	test(`lyrics.ts displays and lights what the bench port does: ${c.name}`, () => {
		const doc = parseLyricsDoc(c.doc)!;
		expect(doc).not.toBeNull();
		expect(doc.lines.map((l) => [l.text, l.start, l.end])).toEqual(c.rows);
		expect(c.positions.map((pos) => litAt(doc, pos))).toEqual(c.lit);
	});
}
