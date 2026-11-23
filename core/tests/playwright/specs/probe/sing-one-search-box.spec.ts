// THE SING TAB IS ONE SEARCH BOX (proposal 21). The Music / Everything / YouTube / Library menu under the field is
// gone: its choices returned the same rows and "Library" meant everything anyone had searched for. Five claims:
//   1. At 390x844 and 320x568 the find row is the field alone: no `<select>` in the column, and the row is one
//      control tall, so the content below it starts where the menu used to.
//   2. `Not it? Search everything` is the one way wider, and it lasts for ONE query: its tap re-runs the query
//      with `source=all`, and the next keystroke, or a clear, goes back to the route's default (no `source`).
//   3. The narrowing filter is still reachable off-screen: `/?source=local` sends `source=local`, and the widen is
//      still offered there, so a shared narrowed link is never a search with no way wider.
//   4. The widen removes the button it was tapped on, so focus moves to the widened results' first heading and
//      the live region says the search went wider; focus never falls to <body>.
//   5. The topbar is one row at 320 and 390 with a long name: the name ellipsises, the wordmark and gear stay whole.
// Requests are read off the wire the page sends, not inferred from the rows, because the rows mostly match.
//
// `SING_BOX_SHOTS=<dir>` writes the idle screen at both widths and the results before and after the widen.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openBrowseFromHome } from '../../world/actors';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Request } from '@playwright/test';

const SHOTS = process.env.SING_BOX_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shoot = async (page: Page, name: string) => {
	if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const WIDEN = { name: /Not it\? Search everything/ };

/** The next /api/search the page sends for `q`, and the `source` it carries ('' for none). */
function nextSearch(page: Page, q: string): Promise<string> {
	return page
		.waitForRequest(
			(r: Request) => {
				const u = new URL(r.url());
				return u.pathname === '/api/search' && u.searchParams.get('q') === q;
			},
			{ timeout: 20_000 }
		)
		.then((r) => new URL(r.url()).searchParams.get('source') ?? '');
}

test('the find row is the search field alone at 390 and 320', async ({ world }) => {
	const page = await world.openPhone('Maya');
	for (const vp of [
		{ width: 390, height: 844 },
		{ width: 320, height: 568 }
	]) {
		await page.setViewportSize(vp);
		await page.goto('/');
		await openBrowseFromHome(page);
		await expect(page.locator('main select'), `no menu in the Sing column at ${vp.width}`).toHaveCount(0);
		await expect(page.getByRole('combobox', { name: 'Where to search' })).toHaveCount(0);
		const row = await page.locator('.find-row').boundingBox();
		const field = await page.locator(SEL.findBox).first().boundingBox();
		expect(row && field, 'find row and field both render').toBeTruthy();
		// One control tall: the menu wrapped onto its own line below 520px, which made the row 124px at 320.
		expect(Math.round(row!.height), `the row is the field's height at ${vp.width}`).toBe(Math.round(field!.height));
		expect(Math.round(field!.width), `the field spans the row at ${vp.width}`).toBe(Math.round(row!.width));
		await shoot(page, `idle-${vp.width}`);
	}
});

test('Search everything is the one way wider, and only for the query it was tapped on', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await page.setViewportSize({ width: 390, height: 844 });
	await openBrowseFromHome(page);
	const search = page.locator(SEL.search);

	let sent = nextSearch(page, track.title);
	await search.fill(track.title);
	expect(await sent, 'a typed query asks the default set').toBe('');
	const widen = page.getByRole('button', WIDEN);
	await widen.waitFor({ timeout: 30_000 });
	await shoot(page, 'results-390');

	sent = nextSearch(page, track.title);
	await widen.click();
	expect(await sent, 'the widen re-runs the same query wider').toBe('all');
	await page.locator(SEL.songRow).first().waitFor({ timeout: 30_000 });
	await expect(widen, 'already wide: nothing wider to offer').toHaveCount(0);
	await shoot(page, 'widened-390');

	const refined = `${track.title}s`;
	sent = nextSearch(page, refined);
	await search.fill(refined);
	expect(await sent, 'the next keystroke goes back to the default').toBe('');

	await page.getByRole('button', { name: 'Clear the search' }).click();
	sent = nextSearch(page, track.title);
	await search.fill(track.title);
	expect(await sent, 'a clear goes back to the default').toBe('');
	await expect(widen, 'the widen is offered again on the default').toBeVisible({ timeout: 30_000 });
});

test('/?source= narrows off-screen, for testing one source', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await page.goto('/?source=local');
	await openBrowseFromHome(page);
	const sent = nextSearch(page, track.title);
	await page.locator(SEL.search).fill(track.title);
	expect(await sent, 'the URL filter passes through').toBe('local');
	await expect(page.locator(SEL.songRow).first()).toBeVisible({ timeout: 20_000 });
	const widen = page.getByRole('button', WIDEN);
	await expect(widen, 'a narrowed link still offers the way wider').toBeVisible({ timeout: 20_000 });
	const wide = nextSearch(page, track.title);
	await widen.click();
	expect(await wide, 'and it widens past the URL filter').toBe('all');
});

test('the widen hands focus to the widened results and says so', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await page.setViewportSize({ width: 390, height: 844 });
	await openBrowseFromHome(page);
	await page.locator(SEL.search).fill(track.title);
	const widen = page.getByRole('button', WIDEN);
	await widen.waitFor({ timeout: 30_000 });
	await widen.focus();
	await page.keyboard.press('Enter');
	const firstHead = page.locator('main h2.grouphead').first();
	await expect(firstHead, 'focus lands on the first group heading').toBeFocused({ timeout: 30_000 });
	await expect(page.locator('.sr-live'), 'the live region says it went wider').toHaveText(/^Searched everything: /);
});

for (const width of [320, 390]) {
	test(`the topbar is one row at ${width} with a long name`, async ({ world }) => {
		const page = await world.openPhone('Alexandria');
		await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
		await page.goto('/');
		await openBrowseFromHome(page);
		const brand = (await page.locator('.topbar .brand').boundingBox())!;
		const cluster = (await page.locator('.topbar .me-cluster').boundingBox())!;
		const gear = (await page.getByRole('link', { name: 'Settings' }).boundingBox())!;
		const dot = (await page.locator('.topbar .me-dot').boundingBox())!;
		expect(cluster.y, 'the name, avatar and gear stay on the wordmark row').toBeLessThan(brand.y + brand.height);
		expect(gear.x + gear.width, 'the gear stays on screen').toBeLessThanOrEqual(width);
		expect(dot.x + dot.width, 'the avatar is left of the gear').toBeLessThanOrEqual(gear.x);
		const name = await page.locator('.topbar .me-name').evaluate((el) => ({
			clipped: el.scrollWidth > el.clientWidth,
			ellipsis: getComputedStyle(el).textOverflow === 'ellipsis'
		}));
		if (name.clipped) expect(name.ellipsis, 'a clipped name ends in an ellipsis').toBe(true);
		const wordmark = await page.locator('.topbar .brand').evaluate((el) => el.scrollWidth <= el.clientWidth);
		expect(wordmark, 'the wordmark is never cut').toBe(true);
		await shoot(page, `topbar-${width}`);
	});
}
