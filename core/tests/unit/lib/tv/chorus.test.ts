// Proposal 38: which lines are the chorus, found from repeated runs of words. Three real songs' truth sheets, then the
// shapes that must mark nothing or only the right run.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chorusLines } from '$lib/tv/lyrics';

const lines = (...texts: string[]) => texts.map((text) => ({ text }));
const truth = (song: string) =>
	(
		JSON.parse(
			readFileSync(
				join(import.meta.dir, '../../../../../docs/benchmarks/benchmark-songs', song, 'truth-lines.json'),
				'utf8'
			)
		) as { lines: { text: string }[] }
	).lines;
/** The marked lines as `first..last` blocks. */
const blocks = (marked: Set<number>) => {
	const out: string[] = [];
	for (const i of [...marked].sort((a, b) => a - b)) {
		if (marked.has(i - 1)) out[out.length - 1] = `${out.at(-1)!.split('..')[0]}..${i}`;
		else out.push(`${i}..${i}`);
	}
	return out;
};

test('Mayday: "Help me" through "Calling out MAYDAY", both times, and not the outro\'s reprise', () => {
	const song = truth('tfr-mayday');
	expect(blocks(chorusLines(song))).toEqual(['9..17', '27..35']);
	expect(song[9]!.text).toBe('Help me');
});

test('Chosen: from "\'Cause you\'re the One", not the verse line that leads into it each time', () => {
	const song = truth('tfr-chosen');
	expect(blocks(chorusLines(song))).toEqual(['7..13', '27..33']);
	expect(song[6]!.text).toContain("Don't be afraid"); // also closes verse 2, so it is the verse's
});

test('Fly Away: the build and the chorus, sung twice as one block, over the intro hook said ten times', () => {
	// shortcut: the rule reads "Don't you be afraid" through "A thousand views" as one section, since it repeats
	// whole; the four "We're rising" runs alone score less. Upgrade path: proposal 38's option A2 (audio sections).
	expect(blocks(chorusLines(truth('tfr-flyaway')))).toEqual(['16..35', '44..63']);
});

test('a song with no repeated run of lines marks nothing', () => {
	expect(chorusLines(lines('one', 'two', 'three', 'four', 'five', 'six')).size).toBe(0);
});

test('a line repeated on its own is a shout, not a chorus', () => {
	expect(chorusLines(lines('a verse', 'Hey!', 'more verse', 'Hey!', 'the end', 'Hey!')).size).toBe(0);
});

test('a chant over 60% of the song marks nothing', () => {
	expect(chorusLines(lines('la la', 'la la la', 'la la', 'la la la', 'la la', 'la la la', 'bye')).size).toBe(0);
});

test('only the run sung most is marked, not a shorter hook as well', () => {
	const song = lines(
		'verse one a',
		'verse one b',
		'chorus a',
		'chorus b',
		'chorus c',
		'hook x',
		'hook y',
		'verse two a',
		'chorus a',
		'chorus b',
		'chorus c',
		'bridge',
		'hook x',
		'hook y'
	);
	expect(blocks(chorusLines(song))).toEqual(['2..4', '8..10']);
});

test('case, punctuation, apostrophes and bracketed ad-libs do not split a repeat', () => {
	const song = lines('Verse here', "Don't stop", 'ME NOW (yeah!)', 'verse there', 'dont stop!', 'me now', 'end');
	expect(blocks(chorusLines(song))).toEqual(['1..2', '4..5']);
	// A curly apostrophe (U+2019) joins too.
	const curly = lines(
		'Verse here',
		`Don${String.fromCharCode(0x2019)}t stop`,
		'me now',
		'verse there',
		'dont stop',
		'me now',
		'end'
	);
	expect(blocks(chorusLines(curly))).toEqual(['1..2', '4..5']);
});

test('a line that is only an ad-lib still counts as the words it carries', () => {
	const song = lines(
		'a',
		'Is anybody there?',
		'(is anybody there?)',
		'b',
		'c',
		'Is anybody there?',
		'(is anybody there?)',
		'd'
	);
	expect(blocks(chorusLines(song))).toEqual(['1..2', '5..6']);
});

test('a last chorus with changed words keeps the runs that did repeat', () => {
	const song = lines(
		'v1',
		'c one',
		'c two',
		'c three',
		'v2',
		'c one',
		'c two',
		'c three',
		'v3',
		'c one',
		'c 2 changed',
		'c three'
	);
	expect(blocks(chorusLines(song))).toEqual(['1..3', '5..7']);
});

test('a duet reads the words alone, so the parts do not hide the chorus', () => {
	const song = [
		{ text: 'his verse', part: 'A' },
		{ text: 'together now', part: 'A' },
		{ text: 'sing it loud', part: 'B' },
		{ text: 'her verse', part: 'B' },
		{ text: 'together now', part: 'B' },
		{ text: 'sing it loud', part: 'A' },
		{ text: 'his last line', part: 'A' },
		{ text: 'her last line', part: 'B' }
	];
	expect(blocks(chorusLines(song))).toEqual(['1..2', '4..5']);
});

test('instrumental marks break a run, so two of them never make a chorus', () => {
	expect(chorusLines(lines('♪', 'a', '♪', 'b', '♪', 'c')).size).toBe(0);
});

test('under 1 ms on a 120-line document', () => {
	const song = lines(...Array.from({ length: 120 }, (_, i) => (i % 20 < 6 ? `chorus ${i % 20}` : `verse ${i}`)));
	chorusLines(song); // warm
	const t0 = performance.now();
	for (let k = 0; k < 20; k++) chorusLines(song);
	expect((performance.now() - t0) / 20).toBeLessThan(1);
});
