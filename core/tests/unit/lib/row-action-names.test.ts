import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';
import {
	keyStepName,
	pickAnotherName,
	removeTurnName,
	reorderName,
	songRef,
	tryAgainName
} from '$lib/phrasing/row-action-names';

test('a row name carries the song, and the artist only when the row shows one', () => {
	expect(songRef('Sweet Caroline', 'Neil Diamond')).toBe('Sweet Caroline by Neil Diamond');
	expect(songRef('Sweet Caroline', '')).toBe('Sweet Caroline');
	expect(songRef('Sweet Caroline', null)).toBe('Sweet Caroline');
});

test('two rows never share a name', () => {
	for (const name of [removeTurnName, reorderName, tryAgainName, pickAnotherName]) {
		expect(name('Sweet Caroline')).not.toBe(name('Bohemian Rhapsody'));
	}
	expect(keyStepName(-1, 'Sweet Caroline')).toBe('Lower Sweet Caroline by one semitone');
	expect(keyStepName(1, 'Sweet Caroline')).toBe('Raise Sweet Caroline by one semitone');
});

test('two singers on one song get two grip names', () => {
	expect(reorderName('Sweet Caroline', 'Theo')).toBe("Reorder Sweet Caroline, Theo's turn — drag, or use arrow keys");
	expect(reorderName('Sweet Caroline', 'Theo')).not.toBe(reorderName('Sweet Caroline', 'Ana'));
	expect(reorderName('Sweet Caroline', 'You')).toBe('Reorder Sweet Caroline, your turn — drag, or use arrow keys');
});

/** A source file with its comments blanked, so prose describing the wiring cannot satisfy a scan. */
const code = (file: string): string =>
	readFileSync(at(file), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\/\/[^\n]*/g, ' ');

test('every repeated row and card button takes its name from the helpers, with the song in it', () => {
	// The probe drives the Sing and Queue rows; these are the buttons it does not reach.
	for (const file of ['src/lib/components/QueueRow.svelte', 'src/lib/components/ProcessingCard.svelte']) {
		const src = code(file);
		for (const call of [
			'reorderName(title, singerName)',
			'removeTurnName(title)',
			'tryAgainName(title)',
			'pickAnotherName(title)'
		]) {
			expect(src, `${file}: ${call}`).toContain(`aria-label={${call}}`);
		}
	}
	const deck = code('src/lib/components/OnDeckCard.svelte');
	expect(deck).toContain('aria-label={keyStepName(-1, title)}');
	expect(deck).toContain('aria-label={keyStepName(1, title)}');
	const queue = code('src/routes/queue/+page.svelte');
	expect(queue).toContain('aria-label={keyStepName(-1, nowTitle)}');
	expect(queue).toContain('aria-label={keyStepName(1, nowTitle)}');
	expect(code('src/lib/components/SongRow.svelte')).toContain('songRef(title, byline)');
});

test('a word button names itself starting with the words it shows (SC 2.5.3)', () => {
	expect(tryAgainName('Sweet Caroline').startsWith('Try again')).toBe(true);
	expect(pickAnotherName('Sweet Caroline').startsWith('Pick another')).toBe(true);
});
