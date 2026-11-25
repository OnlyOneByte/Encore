// YOUR CARD COMES TO YOU: at 320x400 Theo's failed card's × starts under the dock, and /queue scrolls it up into
// reach, once. His On deck card needs no scroll since redesign step 5b: it is the first thing on the page.
import { test, expect } from '../../world/fixtures';
import { DEMO_LIBRARY } from '../../world/seed';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue, queueReady, readySong } from '../../world/actors';
import type { Page } from '@playwright/test';

/** Past the 30 s heads-up window by a few seconds, so each test waits a little for it. */
const SECS = 40;
test.use({ demoLibrary: [DEMO_LIBRARY.map((t) => ({ ...t, seconds: SECS })), { scope: 'test' }] });

/** Where the card's first control sits against the header and the dock, and how far the page has scrolled. */
const reach = (page: Page, card: string) =>
	page.evaluate((sel) => {
		const c = document.querySelector(sel)?.querySelector('button')?.getBoundingClientRect();
		return {
			top: c?.top ?? NaN,
			bottom: c?.bottom ?? NaN,
			header: document.querySelector('.page-header')!.getBoundingClientRect().bottom,
			dock: document.querySelector('.dock')!.getBoundingClientRect().top,
			scrollY: Math.round(window.scrollY)
		};
	}, card);
const reachable = (r: Awaited<ReturnType<typeof reach>>) => r.top >= r.header && r.bottom <= r.dock;

async function theoOnDeck(world: Parameters<Parameters<typeof test>[2]>[0]['world']) {
	const worker = await startFakeWorker(world, { seconds: SECS });
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	await theo.setViewportSize({ width: 320, height: 400 });
	await readySong(world, maya, 'caroline');
	await readySong(world, maya, 'believin');
	await world.openTv();
	await queueReady(maya, 'caroline');
	await queueReady(theo, 'believin');
	await openQueue(theo);
	await expect(theo.locator('.deck')).toBeVisible({ timeout: 10_000 });
	await theo.evaluate(() => window.scrollTo(0, 0));
	return { worker, maya, theo };
}

test('320x400: your On deck card is the first thing on the page, so its key clears the dock with no scroll', async ({
	world
}) => {
	// Redesign step 5b put the card above the Now row, so there is nothing to bring up: it is in reach from the start
	// and still is at the heads-up, and the page never moves.
	const { worker, theo } = await theoOnDeck(world);
	try {
		expect(
			reachable(await reach(theo, '.deck')),
			`the card starts out of reach: ${JSON.stringify(await reach(theo, '.deck'))}`
		).toBe(true);
		await expect(theo.locator('.deck.heads-up')).toBeVisible({ timeout: SECS * 1_000 });
		await theo.waitForTimeout(1_500);
		const r = await reach(theo, '.deck');
		expect(reachable(r), `the heads-up card is out of reach: ${JSON.stringify(r)}`).toBe(true);
		expect(r.scrollY, 'the page scrolled').toBe(0);
	} finally {
		await worker.stop();
	}
});

test('320x400: your song that cannot be made comes up so its × clears the dock', async ({ world }) => {
	// Theo has ONLY the failing song, so no heads-up competes for the scroll. Maya's Now card and the short screen put it under the dock.
	const worker = await startFakeWorker(world, { seconds: SECS });
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	await theo.setViewportSize({ width: 320, height: 400 });
	await readySong(world, maya, 'caroline');
	await world.openTv();
	await queueReady(maya, 'caroline');
	await worker.stop();
	// Theo queues with NO worker attached, so the song waits; his own taps are then past the 3 s quiet window before
	// the failing worker joins. Otherwise the fake failure lands inside it and the page rightly stays put.
	await theo.goto('/');
	await openBrowseFromHome(theo);
	await theo.locator(SEL.search).fill('bohemian');
	await theo.locator(`${SEL.addTurn}, ${SEL.sing}`).first().click();
	await openQueue(theo);
	await theo.evaluate(() => window.scrollTo(0, 0));
	await theo.waitForTimeout(3_500);
	const bad = await startFakeWorker(world, { seconds: SECS, workerId: 'bad-1', fail: 'stems' });
	try {
		await expect(theo.locator(SEL.failedTurn)).toBeAttached({ timeout: 60_000 });
		await expect.poll(async () => reachable(await reach(theo, SEL.failedTurn)), { timeout: 5_000 }).toBe(true);
		expect((await reach(theo, SEL.failedTurn)).scrollY, 'the page scrolled').toBeGreaterThan(0);
	} finally {
		await bad.stop();
		await worker.stop().catch(() => {});
	}
});
