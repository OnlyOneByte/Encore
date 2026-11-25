// The saved picture's setlist: a long title gives way to its detail, and a long night never runs into the footer.
import { test, expect } from 'bun:test';
import { capRows, fitText, PICTURE_ROWS, wrapText } from '$lib/night-picture';

const measure = (t: string) => t.length * 20; // 20 px a character, as a stand-in for canvas measureText

test('a title that fits is untouched; a longer one is cut to the width with an ellipsis', () => {
	expect(fitText('Mayday', 200, measure)).toBe('Mayday');
	const long = "Don't Stop Believin' (2022 Remaster)";
	const cut = fitText(long, 400, measure);
	expect(cut.endsWith('…')).toBe(true);
	expect(measure(cut)).toBeLessThanOrEqual(400);
	expect(long.startsWith(cut.slice(0, -1))).toBe(true);
	expect(fitText('abc', 0, measure)).toBe('…');
});

test('the loudest title wraps to two lines between words, and only what is left past them is cut', () => {
	expect(wrapText('Mayday', 400, measure)).toEqual(['Mayday']);
	const title = 'Sweet Caroline (good times never seemed so good)'; // 48 characters: 960 px
	expect(wrapText(title, 600, measure)).toEqual(['Sweet Caroline (good times', 'never seemed so good)']);
	const longer = wrapText(`${title} live at the Garden 1972`, 600, measure);
	expect(longer).toHaveLength(2);
	expect(longer[1]!.endsWith('…')).toBe(true);
	for (const line of longer) expect(measure(line)).toBeLessThanOrEqual(600);
	// One word too long for the line is cut, not left to overflow.
	expect(wrapText('Supercalifragilisticexpialidocious', 200, measure)).toEqual([
		fitText('Supercalifragilisticexpialidocious', 200, measure)
	]);
});

test('a setlist of more than seven songs keeps six and says how many more', () => {
	const rows = Array.from({ length: 9 }, (_, i) => [`Song ${i + 1}`, `${i} cheers`] as [string, string]);
	expect(capRows(rows.slice(0, 7))).toHaveLength(7);
	const capped = capRows(rows);
	expect(capped).toHaveLength(PICTURE_ROWS);
	expect(capped.at(-1)).toEqual(['+3 more', '']);
	expect(capped[5]![0]).toBe('Song 6');
});

test('seven rows and the key line end above the footer', () => {
	// Row baselines step 96 px from the kick at 440, the key line sits 80 px under the last, and the 36 px footer
	// sits on 1350 - 96.
	expect(440 + PICTURE_ROWS * 96 + 80).toBeLessThan(1350 - 96 - 36);
});
