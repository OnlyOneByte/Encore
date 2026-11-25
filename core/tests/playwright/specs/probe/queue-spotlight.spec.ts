// YOUR CARD ON QUEUE IS ONE BOX (redesign steps 5 and 5b, #1154). Maya sings, Theo is on deck and watches /queue.
//   1. At the phone's size his On deck card is the first thing on the screen, above the compact Now row, and its keys
//      sit between the header and the dock (G1).
//   2. Maya's song ends and his starts: the same card element turns "You're up" at the same height, with no layout
//      shift inside main, so nothing under his thumb moves (tenet 3).
//   3. A reload draws the same card at the same height (live equals reloaded).
import { test, expect } from '../../world/fixtures';
import { DEMO_LIBRARY } from '../../world/seed';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openQueue, queueReady, readySong, transportTap } from '../../world/actors';
import type { Page } from '@playwright/test';

const SECS = 60;
test.use({ demoLibrary: [DEMO_LIBRARY.map((t) => ({ ...t, seconds: SECS })), { scope: 'test' }] });

const KEY_UP = { role: 'button' as const, name: /^Raise .* by one semitone$/ };

/** Layout shifts inside `main` from now on, sources named. */
async function watchShifts(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { __shifts: { value: number; src: string[] }[] };
		w.__shifts = [];
		const main = document.querySelector('main')!;
		new PerformanceObserver((list) => {
			for (const e of list.getEntries() as unknown as { value: number; sources: { node?: Node | null }[] }[]) {
				const src = e.sources.filter((s) => !!s.node && main.contains(s.node));
				if (src.length)
					w.__shifts.push({
						value: e.value,
						src: src.map((s) => {
							const n = s.node as Element;
							const el = n.nodeType === 1 ? n : n.parentElement;
							return `${el?.className?.toString() ?? '?'} "${(n.textContent ?? '').trim().slice(0, 24)}"`;
						})
					});
			}
		}).observe({ type: 'layout-shift', buffered: false });
	});
}
const shifts = (page: Page) =>
	page.evaluate(() => (window as unknown as { __shifts: { value: number; src: string[] }[] }).__shifts);

for (const [width, height] of [
	[390, 844],
	[320, 568]
] as const) {
	test(`${width}x${height}: On deck sits above the dock, and turns into You're up as the same box`, async ({
		world
	}, testInfo) => {
		test.setTimeout(150_000);
		const worker = await startFakeWorker(world, { seconds: SECS });
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		try {
			await readySong(world, maya, 'caroline');
			await readySong(world, maya, 'believin');
		} finally {
			await worker.stop();
		}
		await theo.setViewportSize({ width, height });
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		await openQueue(theo);
		const card = theo.locator(SEL.queueMyCard);
		await expect(card.getByRole('region', { name: 'On deck' })).toContainText('You’re next', { timeout: 20_000 });
		await theo.evaluate(() => document.fonts.ready.then(() => true));
		const nowRow = (await theo.locator(SEL.queueNowCard).boundingBox())!;
		expect((await card.boundingBox())!.y, 'your card sits above the Now row').toBeLessThan(nowRow.y);

		// G1: the card's keys between the header's bottom and the dock's top, with no scroll.
		const header = (await theo.locator('.page-header').boundingBox())!;
		const dock = (await theo.locator(SEL.dock).boundingBox())!;
		const key = (await card.getByRole(KEY_UP.role, { name: KEY_UP.name }).boundingBox())!;
		expect(await theo.evaluate(() => window.scrollY), 'the page scrolled').toBe(0);
		expect(key.y, 'the key sits under the header').toBeGreaterThanOrEqual(header.y + header.height);
		expect(key.y + key.height, 'the key sits above the dock').toBeLessThanOrEqual(dock.y);
		await theo.screenshot({ path: testInfo.outputPath(`queue-on-deck-${width}.png`) });

		// The handoff: the same element, the same height, nothing shifted.
		const before = (await card.boundingBox())!;
		await card.evaluate((el) => ((el as HTMLElement).dataset.probe = 'same'));
		await watchShifts(theo);
		await transportTap(maya, 'skip');
		await expect(card).toHaveClass(/\bup\b/, { timeout: 10_000 });
		await expect(theo.locator(SEL.queueNowCard)).toContainText(/believin/i);
		await theo.waitForTimeout(1_000);
		expect(await card.getAttribute('data-probe'), 'the card was remounted at the handoff').toBe('same');
		const after = (await card.boundingBox())!;
		expect(Math.abs(after.height - before.height), `card height ${before.height} -> ${after.height}`).toBeLessThan(1);
		expect(Math.abs(after.y - before.y), `card top ${before.y} -> ${after.y}`).toBeLessThan(1);
		expect(await shifts(theo), 'layout shift inside main at the handoff').toEqual([]);
		await expect(card.getByRole(KEY_UP.role, { name: KEY_UP.name })).toBeEnabled();
		await theo.screenshot({ path: testInfo.outputPath(`queue-up-${width}.png`) });

		// Live equals reloaded.
		await theo.reload();
		await expect(card).toHaveClass(/\bup\b/, { timeout: 15_000 });
		const reloaded = (await card.boundingBox())!;
		expect(
			Math.abs(reloaded.height - after.height),
			`reloaded ${reloaded.height} vs live ${after.height}`
		).toBeLessThan(1);
	});
}
