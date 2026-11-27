// A SLIDER IS DRAWN WHERE IT ENDS UP (#1404). Bits' `contain` measured the thumb and rail after mount, so the server's
// thumb sat on a 0-100 scale and jumped 10-13px right on hydration (CLS 0.00034 at 390 on /settings). The shared slider
// now draws contain's geometry from `--p` (`ui/slider/slider.svelte`), so a cold load records no shift from a thumb, and
// the thumb still follows its value.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';

for (const [w, h] of [
	[390, 844],
	[320, 568]
] as const) {
	test(`a cold /settings load at ${w} shifts no slider thumb`, async ({ world, browser }) => {
		const seed = await world.openPhone('Maya');
		await world.becomeHost(seed);
		const ctx = await browser.newContext({ baseURL: world.baseURL, viewport: { width: w, height: h } });
		await ctx.addCookies(await seed.context().cookies());
		await ctx.addInitScript(() => {
			const w = window as unknown as { __thumbShifts: number[] };
			w.__thumbShifts = [];
			new PerformanceObserver((list) => {
				for (const e of list.getEntries() as unknown as { value: number; sources: { node?: Node | null }[] }[])
					if (e.sources.some((s) => (s.node as Element | null)?.matches?.('[data-slot="slider-thumb"]')))
						w.__thumbShifts.push(e.value);
			}).observe({ type: 'layout-shift', buffered: true });
		});
		const page = await ctx.newPage();
		await page.goto('/settings', { waitUntil: 'networkidle' });
		await expect(page.locator(SEL.setting('queue-order'))).toBeVisible();
		await page.waitForTimeout(1000);
		expect(await page.evaluate(() => (window as unknown as { __thumbShifts: number[] }).__thumbShifts)).toEqual([]);

		// The position follows the value, not a measurement: one step right from the room's 0% moves the thumb right.
		const thumb = page.getByRole('slider', { name: 'Default guide level for the room' });
		const before = (await thumb.boundingBox())!.x;
		await thumb.focus();
		await page.keyboard.press('ArrowRight');
		await expect.poll(async () => (await thumb.boundingBox())!.x).toBeGreaterThan(before);
		await ctx.close();
	});
}
