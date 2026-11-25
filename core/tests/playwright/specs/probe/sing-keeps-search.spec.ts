// #1245: a half-typed search on Sing survives a trip to Queue and back, text and rows, with no new /api/search.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openBrowseFromHome } from '../../world/actors';
import type { Page, TestInfo } from '@playwright/test';

async function frame(page: Page, testInfo: TestInfo, name: string): Promise<void> {
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		const path = testInfo.outputPath(`${name}-${width}.png`);
		await page.screenshot({ path });
		await testInfo.attach(`${name}-${width}.png`, { path, contentType: 'image/png' });
	}
	await page.setViewportSize({ width: 390, height: 844 });
}

function countSearches(page: Page): () => number {
	let n = 0;
	page.on('request', (r) => {
		if (r.url().includes('/api/search')) n++;
	});
	return () => n;
}

const rowTitles = (page: Page) => page.locator(SEL.songRow).allInnerTexts();

async function roundTrip(page: Page) {
	await page.getByRole('link', { name: 'Queue', exact: true }).click();
	await page.waitForURL(/\/queue$/);
	await page.getByRole('link', { name: 'Sing', exact: true }).click();
	await page.waitForURL((u) => u.pathname === '/');
	await openBrowseFromHome(page);
}

test('Sing -> Queue -> Sing keeps the half-typed search and its rows, with no new search', async ({
	world
}, testInfo) => {
	const track = await world.awaitDemoTrack('caroline');
	const partial = track.title.slice(0, Math.max(3, Math.ceil(track.title.length / 2)));
	const page = await world.openPhone('Maya');
	const searches = countSearches(page);
	await openBrowseFromHome(page);
	await page.locator(SEL.search).fill(partial);
	await expect(page.locator(SEL.songRow).first()).toBeVisible({ timeout: 20_000 });
	const before = await rowTitles(page);
	const asked = searches();
	expect(asked, 'the typed search ran once').toBe(1);

	await roundTrip(page);
	await expect(page.locator(SEL.search), 'the half-typed text is still in the box').toHaveValue(partial);
	await expect(page.locator(SEL.songRow).first()).toBeVisible();
	expect(await rowTitles(page), 'the same rows, in the same order').toEqual(before);
	await frame(page, testInfo, 'back-on-sing');
	expect(searches(), 'no new /api/search to show them').toBe(asked);

	// Non-vacuous: the box still searches as before.
	await page.locator(SEL.search).fill(track.title);
	await expect.poll(searches).toBe(asked + 1);
});

test('a search left before its answer is asked again on the way back, once', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Theo');
	await openBrowseFromHome(page);
	// Every answer held back, so the tab is left with the search still in the air.
	let release!: () => void;
	const held = new Promise<void>((done) => (release = done));
	await page.route('**/api/search?*', async (r) => {
		await held;
		await r.fallback();
	});
	const searches = countSearches(page);
	await page.locator(SEL.search).fill(track.title);
	await expect.poll(searches).toBe(1);
	await page.getByRole('link', { name: 'Queue', exact: true }).click();
	await page.waitForURL(/\/queue$/);
	release();
	await page.getByRole('link', { name: 'Sing', exact: true }).click();
	await page.waitForURL((u) => u.pathname === '/');
	await openBrowseFromHome(page);
	await expect(page.locator(SEL.search)).toHaveValue(track.title);
	await expect(page.locator(SEL.songRow).first(), 'the answer the first trip missed').toBeVisible({ timeout: 20_000 });
	expect(searches(), 'asked again exactly once').toBe(2);
});
