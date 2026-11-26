// Proposal 24, PR 2: the Sing tab offers Sing only on a song something connected can make NOW. Per source: a library
// upload needs a maker, a search result also needs a fetcher.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';
import { makeableNow } from '$lib/readiness';
import { cantMakeHeading } from '$lib/phrasing/process-phrasing';
import type { Media } from '$lib/contract';

const song = (source: Media['source']): Media => ({
	id: source,
	source,
	sourceRef: 'ref',
	title: 't',
	durationSec: 200,
	stemStatus: 'none'
});
const all = { canMake: true, canFetch: true };

test('with a maker and a fetcher, every source can be made', () => {
	expect(makeableNow(song('youtube'), all)).toBe(true);
	expect(makeableNow(song('local'), all)).toBe(true);
});

test('with no maker, nothing can be made', () => {
	expect(makeableNow(song('youtube'), { canMake: false, canFetch: true })).toBe(false);
	expect(makeableNow(song('local'), { canMake: false, canFetch: true })).toBe(false);
});

test('an uploads-only box makes a library file and not a search result', () => {
	const uploadsOnly = { canMake: true, canFetch: false };
	expect(makeableNow(song('local'), uploadsOnly)).toBe(true);
	expect(makeableNow(song('youtube'), uploadsOnly)).toBe(false);
	// The configured fetcher cannot turn a local file into one that needs fetching.
	expect(makeableNow(song('local'), uploadsOnly, 'ytdlp')).toBe(true);
});

test('the heading agrees with its count, in the stalled card words', () => {
	expect(cantMakeHeading(1)).toBe("Can't make this one right now");
	expect(cantMakeHeading(3)).toBe("Can't make these right now");
});

/* WIRING, by source scan (the component-mount harness is gone; see waiting-line-wiring.test.ts). */
const home = readFileSync(at('src/routes/(phone)/+page.svelte'), 'utf8');
const songRow = readFileSync(at('src/lib/components/SongRow.svelte'), 'utf8');
const room = readFileSync(at('src/lib/stores/room.ts'), 'utf8');

test('the Sing tab splits unmade rows by makeableNow and gives the unmakeable ones no action', () => {
	expect(home).toContain('!makeableNow(m, verdicts, defaultFetcher)');
	expect(home).toContain('{cantMakeHeading(cantRows.length)}');
	expect(home).toMatch(/<SongRow[^>]*\bcantMake \/>/);
	expect(songRow).toContain('{#if cantMake}');
	// The cantMake arm comes before both action buttons, so neither can render on such a row.
	expect(songRow.indexOf('{#if cantMake}')).toBeLessThan(songRow.indexOf('data-testid="song-sing"'));
	expect(songRow.indexOf('{#if cantMake}')).toBeLessThan(songRow.indexOf('data-testid="song-add"'));
});

test('the room verdicts reach the tab, and the promise line needs both', () => {
	expect(room).toContain('canMake: e.canMake ?? this.verdicts.canMake');
	expect(room).toContain('canFetch: e.canFetch ?? this.verdicts.canFetch');
	expect(home).toContain('verdicts = room.verdicts;');
	expect(home).toContain('const onlyReady = $derived(noMaker || !verdicts.canFetch);');
	expect(home).toMatch(/\(id\) => mediaStatus\.get\(id\),\s*verdicts\.canMake\s*\)/);
	// "See all ready songs" only when nothing ready matched, and LAST, after the rows and the widen, so it pushes nothing.
	expect(home).toContain('{#if cantRows.length && !readyResults.length && library.length}');
	expect(home.indexOf('{#each cantView.shown')).toBeLessThan(home.indexOf('See all ready songs'));
	expect(home.indexOf('Not it? Search everything')).toBeLessThan(home.indexOf('See all ready songs'));
	// A can't-make row keeps the button's box, so the row's height holds when a maker drops.
	expect(songRow).toMatch(/\{#if cantMake\}[\s\S]*?<span class="action-slot" aria-hidden="true"><\/span>/);
});
