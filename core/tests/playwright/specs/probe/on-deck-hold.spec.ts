// A REORDER NEVER SILENTLY STEALS ON DECK (proposal 14), in a real room: a TV and three phones. Maya is singing. The
// queue is Theo `believin`, Ana `prayer`, Ana `brightside`. Theo opens his On deck card and sets -1. Then Maya drags
// Ana's `brightside` from 3rd toward the top.
//
// Before this change the drop landed 1st: Theo's card vanished with no word on any phone, Ana's second song went
// ahead of his first, and the TV's "UP NEXT" flipped to Ana (evidence/p14, main 171a3340). Now the drop stops at 2nd,
// Maya's phone says why, and Theo's card, his -1 and the TV's "UP NEXT Theo" never move.
import { test, expect } from '../../world/fixtures';
import { DEMO_LIBRARY } from '../../world/seed';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openQueue, queueReady, readySong } from '../../world/actors';
import type { Page } from '@playwright/test';

const ON_DECK = 'section[aria-label="On deck"]';

const SECS = 60;
test.use({
	demoLibrary: [
		[
			...DEMO_LIBRARY.map((t) => ({ ...t, seconds: SECS })),
			{ file: 'mr-brightside.wav', seconds: SECS, hz: [207.65, 261.63, 311.13] }
		],
		{ scope: 'test' }
	]
});

const SONGS = ['believin', 'prayer', 'brightside'];
/** The queue's order as `page` shows it, by song. On an observer's phone that is the server's broadcast order. */
async function order(page: Page): Promise<string[]> {
	const rows = await page.locator(SEL.queueRow).allInnerTexts();
	return rows.map((t) => SONGS.find((s) => t.toLowerCase().includes(s)) ?? t);
}

/** Drag the grip of the row titled `from` up past the row titled `over`, with a real pointer. */
async function dragUp(page: Page, from: string, over: string): Promise<void> {
	const grip = page.locator(SEL.queueRow, { hasText: from }).locator(SEL.queueGrip);
	await grip.evaluate((el) => el.scrollIntoView({ block: 'center' }));
	const a = (await grip.boundingBox())!;
	const b = (await page.locator(SEL.queueRow, { hasText: over }).boundingBox())!;
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	for (let i = 1; i <= 12; i++)
		await page.mouse.move(a.x + a.width / 2, a.y + ((b.y - 20 - a.y) * i) / 12, { steps: 2 });
	await page.waitForTimeout(150);
	await page.mouse.up();
}

test('someone else`s drag stops under the On deck row, says why, and Theo`s card, key and the TV never move', async ({
	world
}, testInfo) => {
	test.setTimeout(4 * 60_000);
	/** Stills for the PR, not assertions: each screen before the drop and 3 s after it. */
	const shoot = (step: string, pages: Record<string, Page>) =>
		Promise.all(Object.entries(pages).map(([n, p]) => p.screenshot({ path: testInfo.outputPath(`${step}-${n}.png`) })));
	const worker = await startFakeWorker(world, { seconds: SECS });
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		for (const q of ['caroline', 'believin', 'prayer', 'brightside']) await readySong(world, maya, q);
		const tv = await world.openTv();
		await queueReady(maya, 'caroline');
		await expect(tv.locator(SEL.stateNext)).toBeHidden({ timeout: 30_000 });
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await queueReady(ana, 'brightside');
		for (const p of [maya, theo, ana]) await openQueue(p);

		const deck = theo.locator(ON_DECK);
		await expect(deck).toBeVisible({ timeout: 10_000 });
		await deck.getByRole('button', { name: 'Lower by one semitone' }).click();
		await expect(deck).toContainText('−1');
		await expect(tv.locator('.upnext')).toContainText('Theo');
		await shoot('before', { tv, maya, theo, ana });

		await dragUp(maya, 'brightside', 'believin');

		// The room's order, read on Ana's phone (an observer, so the server's broadcast): Theo is still first.
		await expect.poll(() => order(ana)).toEqual(['believin', 'brightside', 'prayer']);
		await expect.poll(() => order(maya)).toEqual(['believin', 'brightside', 'prayer']);
		// Maya's phone: the drop stopped at 2nd, and one line says why, visibly and to the live region.
		await expect(maya.locator('.reorder-note')).toHaveText('Theo’s on deck. Ana goes right after.');
		await expect(maya.locator('.sr-live')).toHaveText('Theo’s on deck. Ana goes right after.');
		// The held row has no grip on a phone that does not own it; every other row keeps one.
		await expect(maya.locator(SEL.queueRow, { hasText: 'believin' }).locator(SEL.queueGrip)).toHaveCount(0);
		await expect(maya.locator(SEL.queueRow, { hasText: 'brightside' }).locator(SEL.queueGrip)).toHaveCount(1);

		// Theo's phone and the TV: nothing happened, which is the point. Sampled across 3 s, not once.
		for (const ms of [300, 1000, 3000]) {
			await maya.waitForTimeout(ms === 300 ? 300 : ms === 1000 ? 700 : 2000);
			await expect(deck, `${ms} ms after the drop`).toBeVisible();
			await expect(deck).toContainText('believin');
			await expect(deck).toContainText('−1');
			await expect(tv.locator('.upnext')).toContainText('Theo');
			await expect(ana.locator(ON_DECK)).toHaveCount(0);
		}
		await expect(maya.locator('[data-sonner-toast]')).toHaveCount(0);
		await shoot('after', { tv, maya, theo, ana });
	} finally {
		await worker.stop().catch(() => {});
	}
});

test('the hold lifts while the On deck singer is away: the same drag lands first', async ({ world }) => {
	test.setTimeout(4 * 60_000);
	const worker = await startFakeWorker(world, { seconds: SECS });
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		for (const q of ['caroline', 'believin', 'prayer', 'brightside']) await readySong(world, maya, q);
		const tv = await world.openTv();
		await queueReady(maya, 'caroline');
		await expect(tv.locator(SEL.stateNext)).toBeHidden({ timeout: 30_000 });
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await queueReady(ana, 'brightside');
		await openQueue(maya);
		await openQueue(ana);
		// Theo's phone goes in a pocket: the room greys him as away.
		await theo.context().close();
		const theoRow = maya.locator(SEL.queueRow, { hasText: 'believin' });
		await expect(theoRow).toContainText(/away/i, { timeout: 60_000 });
		await expect(theoRow.locator(SEL.queueGrip)).toHaveCount(1);

		await dragUp(maya, 'brightside', 'believin');
		await expect.poll(() => order(ana)).toEqual(['brightside', 'believin', 'prayer']);
		await expect(maya.locator('.reorder-note')).toHaveCount(0);
	} finally {
		await worker.stop().catch(() => {});
	}
});
