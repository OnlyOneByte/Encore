import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: `/library`'s head is a GRID CELL from --bp-lg up, and costs nothing below it.
 *
 * The design review's F5 ("desktop is a stretched phone") was answered once by capping the filter field at
 * `--measure-prose`. That bounded the field and RELOCATED the non-composition: measured in headless Chromium at
 * 1440x900 on this tree's catalog, the capped field painted 560px inside a 1016px column, so 456px of the column
 * trailed it empty while the count and the `Sort & filter` disclosure stacked beneath it in their own full-width
 * rows. The fix is that the head takes both of `main`'s tracks — field in one, `.lib-meta` (count + disclosure +
 * panel) in the other.
 *
 * Two things here are easy to break by accident and are what this guard is for. `.lib-meta` must stay
 * `display: contents` outside the wide arm, or the wrapper starts charging a box on every phone. And the wide arm
 * must place BOTH halves explicitly: grid auto-placement fills whatever head cell is free, so dropping the
 * `.field-slot` placement lets a song row slide up beside the filter field.
 *
 * Geometry itself is not assertable here — `bun test` has no layout. The numbers this file pins are the ones the
 * prose quotes, so a rule that changes cannot leave the comment behind; the pixels are `gate:measured`'s job.
 */

const route = readFileSync(at('src/routes/library/+page.svelte'), 'utf8');
const appCss = readFileSync(at('src/app.css'), 'utf8');
const doc = readFileSync(at('../docs/FRONTEND.md'), 'utf8');

/** The body of the `@media (min-width: <px>)` arm in the route's `<style>`, or undefined when there is none. */
function widthArm(px: number): string | undefined {
	const start = route.indexOf(`@media (min-width: ${px}px) {`);
	if (start < 0) return undefined;
	// Brace-matched rather than regex'd: these arms nest rules, and a lazy `}` stops at the first inner one.
	let depth = 0;
	for (let i = route.indexOf('{', start); i < route.length; i++) {
		if (route[i] === '{') depth++;
		else if (route[i] === '}' && --depth === 0) return route.slice(start, i + 1);
	}
	return undefined;
}

/** A `px` token value out of `app.css`, from the LAST declaration — `--max-w` is re-declared per breakpoint and the
 *  widest arm is the one --bp-lg sees. */
function token(name: string): number {
	const hits = [...appCss.matchAll(new RegExp(`${name}:\\s*(\\d+)px;`, 'g'))];
	expect(hits.length).toBeGreaterThan(0);
	return Number(hits[hits.length - 1]![1]);
}

/** The one inline gutter this app spends, and the row grid's column gap: both are `--space-2xl`. */
const gutter = () => token('--space-2xl');
/** One song-row track at --bp-lg: the shell's two gutters and `main`'s two come off `--max-w`, then halve. */
const track = () => (token('--max-w') - 4 * gutter() - gutter()) / 2;

test('the head is placed in BOTH tracks, and the arm is a --bp-* member', () => {
	// 1200 is --bp-lg, declared in app.css. A media condition is evaluated before the cascade, so the literal is
	// required here — which is exactly why it has to be checked against the token rather than trusted.
	expect(appCss).toContain('--bp-lg: 1200px;');

	const arm = widthArm(1200);
	expect(arm).toBeDefined();
	// Both halves explicit. Either one missing hands a cell back to auto-placement.
	expect(arm).toMatch(/\.field-slot\s*\{[^}]*grid-column:\s*1;/);
	expect(arm).toMatch(/\.field-slot\s*\{[^}]*grid-row:\s*1;/);
	expect(arm).toMatch(/\.lib-meta\s*\{[^}]*grid-column:\s*2;/);
	expect(arm).toMatch(/\.lib-meta\s*\{[^}]*grid-row:\s*1;/);

	// The two tracks come from the 768 arm's row grid, which this one leans on rather than redeclaring.
	expect(route).toContain('grid-template-columns: repeat(auto-fill, minmax(440px, 1fr));');
	// And the track WIDTH the comments quote is derived, not copied: --max-w at --bp-lg, less the shell's two
	// inline gutters and this page's own two, split in half around one --space-2xl gap.
	expect(track()).toBe(500);
	expect(track() * 2 + gutter()).toBe(1016);
	// 440px is the measured row floor, so two tracks have to clear it or the grid would fall back to one.
	expect(track()).toBeGreaterThanOrEqual(440);
});

test('`.lib-meta` charges nothing below --bp-lg', () => {
	// The base declaration, outside every media arm: strip the arms and it must still be there.
	const armless = route.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
	expect(armless).toMatch(/\.lib-meta\s*\{\s*display:\s*contents;\s*\}/);
	// And no width arm below --bp-lg may re-style it: 768 is the only other one on this page.
	const narrow = widthArm(768);
	expect(narrow).toBeDefined();
	expect(narrow).not.toContain('.lib-meta');
});

test('the wrapper holds the count, the disclosure and the panel — and no song row', () => {
	const open = route.indexOf('<div class="lib-meta">');
	expect(open).toBeGreaterThan(-1);
	const close = route.indexOf('{#if rows.length}', open);
	expect(close).toBeGreaterThan(open);
	const inside = route.slice(open, close);
	expect(inside).toContain('<p class="count" role="status" aria-live="polite">');
	expect(inside).toContain('aria-controls="library-refine"');
	expect(inside).toContain('<div id="library-refine" class="refine">');
	// The rows stay OUTSIDE it, or they would inherit the head's track instead of flowing across both.
	expect(inside).not.toContain('<SongRow');
});

test('the panel stays collapsed by default at every width', () => {
	// The rejected alternative is default-open at --bp-lg. `FACET_CHIP_LIMIT` is why: twelve artist chips and twelve
	// tag chips in one 500px track can exceed the height the page has, which is the fault /library exists to fix.
	expect(route).toMatch(/let panelOpen = \$state\(false\);/);
	expect(route).not.toContain('panelOpen = wide');
	expect(readFileSync(at('src/lib/library-browse.ts'), 'utf8')).toContain('FACET_CHIP_LIMIT = 12;');
});

test('the docs state the corpus every desktop reading was taken on', () => {
	/* The rule, and the only durable half of what this test used to pin: a desktop pixel reading is worthless
	 * without the catalog it was taken against. The claim it was written for was the home SHELF's — "~246px to ~41px"
	 * and a `**with ten ready songs**` qualifier, measured on a ten-ready library when this tree's catalog has two,
	 * so the wide cap could never bind here. That shelf is gone: `/` is the Sing tab and the library is `/library`.
	 * What survives, and is asserted, is the corpus statement plus the superseded reading's own figure, so the
	 * before and after of the rebuild are both checkable rather than only the after. */
	expect(doc).toContain("stem_status='ready'");
	expect(doc).toContain('listReady()');
	expect(doc).toContain('431.6px');
	// The field's cap is inert at --bp-lg because the track is narrower than the measure — derived, not asserted.
	expect(track()).toBeLessThan(token('--measure-prose'));
	expect(route).toContain('THE CAP IS INERT');
});
