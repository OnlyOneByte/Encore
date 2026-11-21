// THE DOCK HOLDS STILL WHEN THE SONG BECOMES YOURS. Maya is singing and Theo is next, so Theo's dock carries the
// reaction row (#963). Ana skips; Theo's song starts and the row is no longer his to use. It used to be REMOVED, so
// the fixed dock shrank 71 px in that one frame (DIV.dock y 680/h 164 -> y 751/h 93, CLS 0.0163, review
// pr-974-976-r2 Q5). Now it rests in place: same slot, buttons faded out and inert. Layout shift must be exactly 0.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { queueReady, readySong } from '../../world/actors';

type Shift = { value: number; hadRecentInput: boolean; sources: string[] };

for (const width of [390, 320]) {
	test(`${width}px: no layout shift on the dock when your song starts`, async ({ world }) => {
		const worker = await startFakeWorker(world);
		try {
			const maya = await world.openPhone('Maya');
			const theo = await world.openPhone('Theo');
			const ana = await world.openPhone('Ana');
			await theo.setViewportSize({ width, height: 844 });
			await readySong(world, maya, 'caroline');
			await readySong(world, maya, 'believin');
			await world.openTv();
			await queueReady(maya, 'caroline');
			await queueReady(theo, 'believin');
			await expect(theo.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 30_000 });
			// Positive control: Maya's song, so Theo can cheer.
			await expect(theo.locator(SEL.npCheer).first()).toBeVisible();
			// Past the playhead's first second and the strip's settle window, as in the motion row.
			await theo.waitForTimeout(3_000);

			const dock = theo.locator(SEL.dock);
			const before = await dock.boundingBox();
			await theo.evaluate(() => {
				const w = window as unknown as { __shifts: Shift[] };
				w.__shifts = [];
				new PerformanceObserver((list) => {
					for (const e of list.getEntries() as unknown as {
						value: number;
						hadRecentInput: boolean;
						sources: { node?: Node | null }[];
					}[])
						w.__shifts.push({
							value: e.value,
							hadRecentInput: e.hadRecentInput,
							sources: e.sources.map((s) => (s.node as Element | null)?.className?.toString() ?? '?')
						});
				}).observe({ type: 'layout-shift', buffered: false });
			});

			await ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
			await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i, { timeout: 5_000 });
			await expect(theo.locator('.youre-up')).toBeVisible();
			// Past the row's --motion-base fade and a few frames more.
			await theo.waitForTimeout(1_000);

			const shifts = await theo.evaluate(() => (window as unknown as { __shifts: Shift[] }).__shifts);
			expect(shifts, 'layout-shift entries on the singer phone as the song became theirs').toEqual([]);
			expect(await dock.boundingBox(), 'the dock moved or resized').toEqual(before);
			// The row rests: nothing to find or tap on the singer's own phone, and the server refuses it anyway.
			await expect(theo.locator(SEL.npCheers)).toHaveAttribute('inert');
			// Computed style, not `toBeHidden`: with the fade rule deleted, `toBeHidden` still passed here.
			for (const cheer of await theo.locator(SEL.npCheer).all()) {
				await expect(cheer).toHaveCSS('opacity', '0');
				await expect(cheer).toHaveCSS('visibility', 'hidden');
			}
		} finally {
			await worker.stop();
		}
	});
}
