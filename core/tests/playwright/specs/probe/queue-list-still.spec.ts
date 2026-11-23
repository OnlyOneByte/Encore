// THE LIST ON /queue HOLDS STILL WHEN YOUR SONG STARTS, AND WHEN A COOKING CARD CHANGES (proposal 18). Theo watches
// /queue; every change comes from another phone or the worker, so every layout shift counts.
//
// (a) YOUR SONG STARTS. Theo is On deck with two songs queued behind him and Maya taps skip. His On deck card leaves
// (348 px) and the "Queued" heading and rows under it used to jump up by its height in one frame, then his row left
// the list 12 ms later and the rows under it jumped again (CLS 0.1379 at 390, 0.0357 at 320, on main). Under reduced
// motion that is a cut on purpose, as #1002's hold is: the heading lands at its new place on the first frame.
//
// (b) A COOKING CARD CHANGES, scrolled to the bottom. Theo's song failed and is the last row; Maya taps Try again.
// The card goes 137 → 109 px (making) → 69 px (ready), and the browser clamped the scroll to the shorter page, so the
// whole column slid down 28 px and then 40 px. CLS never sees a clamp, so this reads `scrollY` and the first row's
// top on every frame. Not motion, so reduced motion keeps it too. And the kept height goes once Theo scrolls up.
//
// (c) A ROW UNDER THE CARD, at the top of the page: the row under Theo's card must not shift as the card shrinks.
//
// Chromium files no layout shift for an element with a running transform animation, so (a) also reads where the
// heading is DRAWN on the first frame after the change: a hold in the wrong place passes the CLS half alone.
import { test, expect } from '../../world/fixtures';
import { DEMO_LIBRARY } from '../../world/seed';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue, queueReady, readySong } from '../../world/actors';
import type { Page } from '@playwright/test';

// Long songs, so nothing ends by itself while a step is watched.
const SECS = 300;
test.use({ demoLibrary: [DEMO_LIBRARY.map((t) => ({ ...t, seconds: SECS })), { scope: 'test' }] });

type Watch = {
	shifts: { value: number; sources: string[] }[];
	headBefore: number | null;
	headFirst: number | null;
	syBefore: number;
	firstRowBefore: number | null;
	maxDrift: number;
};

/** Layout shifts inside `main` (not a row's own content), the heading's first drawn frame, and the scroll's drift. */
async function watch(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { __w: Watch; __obs?: PerformanceObserver; __mo?: MutationObserver; __run?: number };
		const main = document.querySelector('main')!;
		const head = () => document.querySelector('main .grouphead')?.getBoundingClientRect().top ?? null;
		const firstRow = () => document.querySelector('main .qrow')?.getBoundingClientRect().top ?? null;
		w.__obs?.disconnect();
		w.__mo?.disconnect();
		w.__run = (w.__run ?? 0) + 1;
		const run = w.__run;
		w.__w = {
			shifts: [],
			headBefore: head(),
			headFirst: null,
			syBefore: scrollY,
			firstRowBefore: firstRow(),
			maxDrift: 0
		};
		w.__obs = new PerformanceObserver((list) => {
			for (const e of list.getEntries() as unknown as {
				value: number;
				hadRecentInput: boolean;
				sources: { node?: Node | null }[];
			}[]) {
				if (e.hadRecentInput) continue;
				// Not the Now card's own content: when your song starts the card grows into yours, and that is the moment.
				const inPage = e.sources.filter(
					(s) =>
						!!s.node &&
						main.contains(s.node) &&
						!(s.node as Element).parentElement?.closest('.qrow') &&
						!(s.node instanceof Element ? s.node : s.node.parentElement)?.closest('.now')
				);
				if (inPage.length)
					w.__w.shifts.push({
						value: e.value,
						sources: inPage.map((s) => (s.node as Element).className?.toString() ?? '?')
					});
			}
		});
		w.__obs.observe({ type: 'layout-shift', buffered: false });
		w.__mo = new MutationObserver(() => {
			w.__mo?.disconnect();
			requestAnimationFrame(() => (w.__w.headFirst = head()));
		});
		w.__mo.observe(main.querySelector('.below')!, { childList: true });
		const sample = () => {
			if (w.__run !== run) return;
			const r = firstRow();
			const rowDrift = r === null || w.__w.firstRowBefore === null ? 0 : Math.abs(r - w.__w.firstRowBefore);
			w.__w.maxDrift = Math.max(w.__w.maxDrift, Math.abs(scrollY - w.__w.syBefore), rowDrift);
			requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
	});
}
const read = (page: Page) => page.evaluate(() => (window as unknown as { __w: Watch }).__w);
const skip = (p: Page) => p.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
const settle = (p: Page) => p.waitForTimeout(1_200);

for (const [width, height] of [
	[390, 844],
	[320, 568]
] as const) {
	for (const reduce of [false, true]) {
		const tag = `${width}px${reduce ? ', reduced motion' : ''}`;

		// 390x1200 too: there the rows under Theo's On deck card start on screen, so their move is measured.
		for (const tall of width === 390 ? [false, true] : [false])
			test(`${tag}${tall ? ', 1200 tall' : ''}: your song starts and the list under it holds still`, async ({
				world
			}) => {
				test.fail(width === 390 && !reduce, 'known main gap: #1044 transform hold under Chromium layout-shift count');
				const worker = await startFakeWorker(world, { seconds: SECS });
				const maya = await world.openPhone('Maya');
				const theo = await world.openPhone('Theo');
				const ana = await world.openPhone('Ana');
				await theo.setViewportSize({ width, height: tall ? 1200 : height });
				if (reduce) await theo.emulateMedia({ reducedMotion: 'reduce' });
				try {
					for (const q of ['caroline', 'believin', 'prayer', 'bohemian']) await readySong(world, maya, q);
					await queueReady(maya, 'caroline');
					await queueReady(theo, 'believin');
					await queueReady(ana, 'prayer');
					await queueReady(maya, 'bohemian');
					await openQueue(theo);
					await expect(theo.locator('section[aria-label="On deck"]')).toBeVisible({ timeout: 10_000 });
					await theo.evaluate(() => document.fonts.ready.then(() => scrollTo(0, 0)));
					await settle(theo);
					await watch(theo);
					await skip(maya);
					await expect(theo.locator('section[aria-label="On deck"]')).toHaveCount(0);
					// Positive control: Theo's card grew from the fan's one line into his own controls in the same moment.
					await expect(theo.locator('.now .ctl')).toBeVisible();
					await settle(theo);
					const w = await read(theo);
					const after = await theo.locator('main .grouphead').evaluate((h) => h.getBoundingClientRect().top);
					expect(w.headBefore! - after, 'the heading moved up into the On deck card’s place').toBeGreaterThan(100);
					expect(w.headFirst, 'the heading was never drawn after the change').not.toBeNull();
					if (reduce) {
						// A cut: no hold, so the heading is at its new place on the first frame.
						expect(Math.abs(w.headFirst! - after), 'px the heading was held under reduced motion').toBeLessThan(2);
					} else {
						expect.soft(w.shifts, 'layout shift inside main as your song starts').toEqual([]);
						expect(Math.abs(w.headFirst! - w.headBefore!), 'px the heading jumped on the first frame').toBeLessThan(2);
					}
				} finally {
					await worker.stop().catch(() => {});
				}
			});

		test(`${tag}: a cooking card at the bottom changes and the page does not slide`, async ({ world }) => {
			const good = await startFakeWorker(world, { seconds: SECS });
			const maya = await world.openPhone('Maya');
			const theo = await world.openPhone('Theo');
			const ana = await world.openPhone('Ana');
			// Short enough that the page scrolls: with Theo's one-line Now card the whole queue fits at 390x844.
			await theo.setViewportSize({ width, height: 520 });
			if (reduce) await theo.emulateMedia({ reducedMotion: 'reduce' });
			let bad: Awaited<ReturnType<typeof startFakeWorker>> | undefined;
			let slow: Awaited<ReturnType<typeof startFakeWorker>> | undefined;
			try {
				for (const q of ['caroline', 'believin', 'prayer']) await readySong(world, maya, q);
				await good.stop();
				bad = await startFakeWorker(world, { seconds: SECS, workerId: 'bad-1', fail: 'stems', slowMs: 500 });
				await queueReady(maya, 'caroline');
				await queueReady(ana, 'prayer');
				await queueReady(maya, 'believin');
				await openBrowseFromHome(theo);
				await theo.locator(SEL.search).fill('bohemian');
				await theo.locator(`${SEL.addTurn}, ${SEL.sing}`).first().click();
				await openQueue(theo);
				await expect(theo.locator(SEL.failedTurn)).toHaveCount(1, { timeout: 60_000 });
				await bad.stop();
				slow = await startFakeWorker(world, { seconds: SECS, workerId: 'slow-1', slowMs: 250 });
				await openQueue(maya);
				await theo.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
				await settle(theo);
				expect(await theo.evaluate(() => scrollY), 'the page is scrolled').toBeGreaterThan(0);
				await watch(theo);
				await maya.locator(`${SEL.failedTurn} [data-testid="card-retry"]`).first().click();
				await expect(theo.locator(SEL.processing)).toHaveCount(1, { timeout: 30_000 });
				await expect(theo.locator(SEL.processing)).toHaveCount(0, { timeout: 90_000 });
				await settle(theo);
				const w = await read(theo);
				expect(w.maxDrift, 'px the page slid as the card got shorter').toBeLessThanOrEqual(1);
				// The kept height goes once Theo scrolls up past it.
				await theo.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
				await expect.poll(() => theo.evaluate(() => document.querySelector('main')!.style.minHeight)).toBe('');
			} finally {
				await bad?.stop().catch(() => {});
				await slow?.stop().catch(() => {});
			}
		});
	}

	test(`${width}px: the row under a cooking card holds still as the card gets shorter`, async ({ world }) => {
		const good = await startFakeWorker(world, { seconds: SECS });
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		await theo.setViewportSize({ width, height });
		let bad: Awaited<ReturnType<typeof startFakeWorker>> | undefined;
		let slow: Awaited<ReturnType<typeof startFakeWorker>> | undefined;
		try {
			for (const q of ['caroline', 'prayer']) await readySong(world, maya, q);
			await good.stop();
			bad = await startFakeWorker(world, { seconds: SECS, workerId: 'bad-1', fail: 'stems', slowMs: 500 });
			await queueReady(maya, 'caroline');
			await openBrowseFromHome(theo);
			await theo.locator(SEL.search).fill('bohemian');
			await theo.locator(`${SEL.addTurn}, ${SEL.sing}`).first().click();
			await openQueue(theo);
			await expect(theo.locator(SEL.failedTurn)).toHaveCount(1, { timeout: 60_000 });
			// Maya's next song goes in after Theo's card, so a row sits under it.
			await queueReady(maya, 'prayer');
			await bad.stop();
			slow = await startFakeWorker(world, { seconds: SECS, workerId: 'slow-1', slowMs: 250 });
			await openQueue(maya);
			await openQueue(theo);
			await expect(theo.locator('main .qrow').last()).not.toHaveClass(/proc/);
			await theo.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
			await settle(theo);
			await watch(theo);
			await maya.locator(`${SEL.failedTurn} [data-testid="card-retry"]`).first().click();
			await expect(theo.locator(SEL.processing)).toHaveCount(1, { timeout: 30_000 });
			await expect(theo.locator(SEL.processing)).toHaveCount(0, { timeout: 90_000 });
			await settle(theo);
			expect((await read(theo)).shifts, 'layout shift inside main as the card changed').toEqual([]);
		} finally {
			await bad?.stop().catch(() => {});
			await slow?.stop().catch(() => {});
		}
	});
}

// THE HOLD STAYS OUT OF THREE MOMENTS: a reorder (the rows would slide through each other), a reconnect (a list that
// changed while the phone was away is a fresh baseline), and Theo's own drag (the live sort owns those rows). Each one
// moves a block that the hold would otherwise ease, so each reads whether `data-hold` was ever written.
async function watchHolds(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { __holds: number; __hmo?: MutationObserver };
		w.__hmo?.disconnect();
		w.__holds = 0;
		w.__hmo = new MutationObserver((ms) => {
			for (const m of ms) if ((m.target as Element).hasAttribute('data-hold')) w.__holds++;
		});
		w.__hmo.observe(document.querySelector('main')!, {
			subtree: true,
			attributes: true,
			attributeFilter: ['data-hold']
		});
	});
}
const holdsSeen = (page: Page) => page.evaluate(() => (window as unknown as { __holds: number }).__holds);

test('390px: a reorder from another phone and a reconnect are not eased', async ({ world }) => {
	const worker = await startFakeWorker(world, { seconds: SECS });
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	const ana = await world.openPhone('Ana');
	await theo.setViewportSize({ width: 390, height: 844 });
	try {
		for (const q of ['caroline', 'believin', 'prayer', 'bohemian']) await readySong(world, maya, q);
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await queueReady(maya, 'bohemian');
		await openQueue(theo);
		await openQueue(maya);
		await expect(theo.locator(SEL.queueRow).last()).toContainText(/bohemian/i, { timeout: 10_000 });
		await settle(theo);

		// Maya moves her song up past Ana's: the two rows swap.
		await watchHolds(theo);
		await maya
			.locator(SEL.queueRow, { hasText: /bohemian/i })
			.locator(SEL.queueGrip)
			.press('ArrowUp');
		await expect(theo.locator(SEL.queueRow).last()).toContainText(/prayer/i, { timeout: 10_000 });
		await settle(theo);
		expect(await holdsSeen(theo), 'holds written for a reorder').toBe(0);

		// Theo drops off, his song starts meanwhile (his On deck card goes), and he comes back.
		await watchHolds(theo);
		await theo.context().setOffline(true);
		await expect(theo.locator(SEL.npStripOffline)).toContainText('Reconnecting…', { timeout: 15_000 });
		await skip(maya);
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/believin/i, { timeout: 10_000 });
		await theo.context().setOffline(false);
		await expect(theo.locator('section[aria-label="On deck"]')).toHaveCount(0, { timeout: 15_000 });
		await settle(theo);
		expect(await holdsSeen(theo), 'holds written for a reconnect').toBe(0);
	} finally {
		await worker.stop().catch(() => {});
	}
});

test('390px: a card that gets shorter during Theo’s own drag is not eased', async ({ world }) => {
	const good = await startFakeWorker(world, { seconds: SECS });
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	await theo.setViewportSize({ width: 390, height: 844 });
	let bad: Awaited<ReturnType<typeof startFakeWorker>> | undefined;
	let slow: Awaited<ReturnType<typeof startFakeWorker>> | undefined;
	try {
		for (const q of ['caroline', 'prayer']) await readySong(world, maya, q);
		await good.stop();
		bad = await startFakeWorker(world, { seconds: SECS, workerId: 'bad-1', fail: 'stems', slowMs: 500 });
		await queueReady(maya, 'caroline');
		await openBrowseFromHome(theo);
		await theo.locator(SEL.search).fill('bohemian');
		await theo.locator(`${SEL.addTurn}, ${SEL.sing}`).first().click();
		await openQueue(theo);
		await expect(theo.locator(SEL.failedTurn)).toHaveCount(1, { timeout: 60_000 });
		await queueReady(maya, 'prayer');
		await bad.stop();
		slow = await startFakeWorker(world, { seconds: SECS, workerId: 'slow-1', slowMs: 250 });
		await openQueue(maya);
		await openQueue(theo);
		await expect(theo.locator('main .qrow').last()).not.toHaveClass(/proc/);
		await theo.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
		await settle(theo);
		// Theo picks his card up and holds it still; the card shrinks under his finger, and the row under it moves.
		const grip = theo.locator(SEL.failedTurn).locator(SEL.queueGrip);
		const g = (await grip.boundingBox())!;
		await theo.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
		await theo.mouse.down();
		await theo.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + 6, { steps: 2 });
		await watchHolds(theo);
		await maya.locator(`${SEL.failedTurn} [data-testid="card-retry"]`).first().click();
		await expect(theo.locator(SEL.processing)).toHaveCount(1, { timeout: 30_000 });
		await expect(theo.locator(SEL.failedTurn)).toHaveCount(0, { timeout: 30_000 });
		await settle(theo);
		expect(await holdsSeen(theo), 'holds written during a drag').toBe(0);
		await theo.mouse.up();
	} finally {
		await bad?.stop().catch(() => {});
		await slow?.stop().catch(() => {});
	}
});
