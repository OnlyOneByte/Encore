import { expect, test } from 'bun:test';
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

test('a word button names itself starting with the words it shows (SC 2.5.3)', () => {
	expect(tryAgainName('Sweet Caroline').startsWith('Try again')).toBe(true);
	expect(pickAnotherName('Sweet Caroline').startsWith('Pick another')).toBe(true);
});
