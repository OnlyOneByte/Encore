// REDESIGN STEP 6 (#1156): "You're up" floods the singer's phone in their colour on every tab but Queue, where the card
// already says it. The flood is its own chunk, fetched once the phone has a turn, so a skip to You're up still paints
// within the 300 ms handoff budget: on a page that has never shown it (cold) and on one that has (warm). It is announced
// once, from the layout's pre-mounted region; it goes on its own timer or on a tap outside its controls.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openQueue, queueReady, readySong, transportTap } from '../../world/actors';
import type { Page } from '@playwright/test';

const FLOOD = '[data-testid="youre-up-flood"]';
/** The handoff budget for skip → You're up (docs/UI-TENETS.md speed budget). */
const HANDOFF_MS = 300;

/** Arms a per-frame watch: the wall-clock time of the first frame that draws the flood. */
const watchFlood = (page: Page) =>
	page.evaluate((sel) => {
		const w = window as unknown as { floodAt: number | null };
		w.floodAt = null;
		const tick = () => {
			if (w.floodAt === null && document.querySelector(sel)) w.floodAt = Date.now();
			if (w.floodAt === null) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, FLOOD);
const floodAt = (page: Page) => page.evaluate(() => (window as unknown as { floodAt: number | null }).floodAt);

test('skip → You’re up paints the flood inside 300 ms, cold and warm, from a chunk fetched before the turn', async ({
	world
}) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world, { seconds: 60 });
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		for (const q of ['caroline', 'believin', 'prayer', 'bohemian']) await readySong(world, maya, q);
		await world.openTv();
		// Rotation: Maya, Theo, Maya, Theo.
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		await queueReady(maya, 'prayer');
		await queueReady(theo, 'bohemian');
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 30_000 });

		// A fresh page that has never shown the flood, on Sing: its chunk is fetched while his turn is only queued.
		// The chunk's name is a hash, so it is known by what it holds: the flood's test id.
		const chunks: { url: string; at: number }[] = [];
		theo.on('response', (r) => {
			if (!/\/_app\/immutable\/.*\.js$/.test(r.url())) return;
			const at = Date.now();
			void r.text().then(
				(body) => body.includes('youre-up-flood') && chunks.push({ url: r.url(), at }),
				() => {}
			);
		});
		await theo.goto('/');
		await expect.poll(() => chunks.length, { message: 'the flood chunk was not preloaded' }).toBeGreaterThan(0);
		await expect(theo.locator(FLOOD)).toHaveCount(0);

		const measure = async (label: string, from: Page) => {
			// Timed from the tap itself, read in the tapping page: the navigation to its Queue tab comes first, and the
			// song has settled, since a tap just after a song change names the one before it.
			await openQueue(from);
			await from.waitForTimeout(1_500);
			await from.evaluate(() => {
				const w = window as unknown as { tapAt: number | null };
				w.tapAt = null;
				document.addEventListener('click', () => (w.tapAt ??= Date.now()), { capture: true, once: true });
			});
			await watchFlood(theo);
			await transportTap(from, 'skip');
			await expect(theo.locator(FLOOD)).toBeVisible({ timeout: 2_000 });
			const t0 = await from.evaluate(() => (window as unknown as { tapAt: number }).tapAt);
			const ms = (await floodAt(theo))! - t0;
			console.log(`youre-up flood ${label}: skip -> first painted frame ${ms} ms`);
			expect(ms, `${label}: skip -> flood`).toBeLessThanOrEqual(HANDOFF_MS);
			return ms;
		};
		const preloadedAt = chunks[0]!.at;
		await measure('cold', maya);
		expect(chunks[0]!.at, 'fetched before the turn, not on it').toBe(preloadedAt);
		// Dismiss, sing a little, and go round again: the same page, the chunk already parsed.
		await theo.locator(FLOOD).click({ position: { x: 20, y: 20 } });
		await expect(theo.locator(FLOOD)).toHaveCount(0);
		// Theo's song -> Maya's second, once it has settled: a tap just after a song change names the one before it.
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await maya.waitForTimeout(1_500);
		await transportTap(maya, 'skip');
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/prayer/i, { timeout: 10_000 });
		await measure('warm', maya);
		expect(chunks, 'one fetch of the chunk for the whole night').toHaveLength(1);
	} finally {
		await worker.stop();
	}
});

test('the flood is in the singer’s colour, said once, has only Restart to press, and goes on a tap outside it', async ({
	world
}) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { seconds: 60 });
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		for (const q of ['caroline', 'believin']) await readySong(world, maya, q);
		await world.openTv();
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 30_000 });
		await theo.goto('/');
		const live = theo.locator('[data-youre-up-live]');
		await expect(live).toHaveText('');
		await live.evaluate((el) => ((el as HTMLElement).dataset.probeSame = 'yes'));

		await transportTap(maya, 'skip');
		const flood = theo.locator(FLOOD);
		await expect(flood).toBeVisible({ timeout: 2_000 });
		await expect(flood).toContainText('Theo, grab the mic');
		await expect(flood).toContainText('You’re up');
		await expect(flood).toContainText(/believin/i);
		// Announced once, from the node that was mounted empty; the flood's own words are hidden from assistive tech.
		await expect(live).toHaveText(/^You’re up, .*believin/i);
		await expect(live).toHaveAttribute('data-probe-same', 'yes');
		expect(await flood.ariaSnapshot()).toBe('- button "Restart"');
		// The whole phone, in a colour that is not the dark ground.
		const box = (await flood.boundingBox())!;
		expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
		const bg = await flood.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(bg).not.toBe('rgb(11, 11, 18)');
		// Nobody else is flooded.
		await expect(maya.locator(FLOOD)).toHaveCount(0);

		// A tap on Restart is a control: the flood stays. A tap anywhere else dismisses it.
		await flood.getByRole('button', { name: 'Restart' }).click();
		await expect(flood).toBeVisible();
		await flood.click({ position: { x: 195, y: 120 } });
		await expect(flood).toHaveCount(0);
		await expect(live).toHaveText('');
	} finally {
		await worker.stop();
	}
});
