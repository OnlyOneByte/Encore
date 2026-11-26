import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { at } from '$test';

// guard (#1309): the root layout imports no styles, so the phone tabs' dock CSS never reaches /tv. Every page then
// needs a layout that does: app.css under (phone), screens.css everywhere else. A page with neither ships unstyled.

const routes = at('src/routes');
const pages = readdirSync(routes, { recursive: true, encoding: 'utf8' })
	.filter((f) => f.endsWith('+page.svelte'))
	.map((f) => join(routes, f));

function styledBy(page: string): string | null {
	for (let dir = dirname(page); dir !== routes; dir = dirname(dir)) {
		const layout = join(dir, '+layout.svelte');
		if (!existsSync(layout)) continue;
		const imported = readFileSync(layout, 'utf8').match(/import '[./]+\/(app|screens)\.css';/);
		if (imported) return imported[1]!;
	}
	return null;
}

test('the root layout imports no stylesheet', () => {
	expect(readFileSync(join(routes, '+layout.svelte'), 'utf8')).not.toMatch(/\.css'/);
});

test('each page gets app.css from the phone layout or screens.css from its own surface', () => {
	expect(pages.length).toBeGreaterThan(10);
	for (const page of pages) {
		const want = relative(routes, page).startsWith('(phone)') ? 'app' : 'screens';
		expect(styledBy(page), relative(routes, page)).toBe(want);
	}
});
