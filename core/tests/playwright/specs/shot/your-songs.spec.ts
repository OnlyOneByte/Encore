// YOUR SONGS' SURFACES (proposal 36, PR 2): the empty Sing box for someone new, a guest's list with the Keep me line,
// and a kept person's list. `YOURS_SHOTS_OUT=<dir>` writes the PNGs there.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openQueue, readySong, singOnce } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SIZES = [
	{ width: 390, height: 844 },
	{ width: 320, height: 568 }
];

test('your songs: the empty box, a guest, and a kept person', async ({ world }, testInfo) => {
	test.setTimeout(240_000);
	const out = process.env.YOURS_SHOTS_OUT ?? testInfo.outputDir;
	mkdirSync(out, { recursive: true });

	async function both(page: Page, ready: () => Promise<void>, name: string): Promise<void> {
		for (const size of SIZES) {
			await page.setViewportSize(size);
			await page.goto('/');
			await ready();
			await page.evaluate(() => document.fonts.ready.then(() => true));
			const path = join(out, `${name}-${size.width}.png`);
			await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
			await testInfo.attach(`${name}-${size.width}.png`, { path, contentType: 'image/png' });
		}
	}

	const worker = await startFakeWorker(world);
	try {
		await world.openTv();
		const theo = await world.openPhone('Theo');
		await both(theo, () => expect(theo.locator(SEL.findBox)).toBeVisible(), 'sing-new-guest');

		await readySong(world, theo, 'caroline');
		await theo.goto('/');
		await singOnce(theo, 'caroline');
		await openQueue(theo);
		for (const want of [/[−-]1/, /[−-]2/]) {
			await theo.locator(SEL.keyBtn).first().click();
			await expect(theo.locator(SEL.keyLabel).first()).toHaveText(want);
		}
		await expect(theo.locator(SEL.npStripTitle)).toHaveCount(0, { timeout: 30_000 });
		for (const q of ['prayer', 'bohemian']) {
			const track = await world.awaitDemoTrack(q);
			expect((await theo.request.put(`/api/me/songs/${track.id}`)).ok()).toBe(true);
		}
		const list = () => expect(theo.getByRole('heading', { name: 'Your songs' })).toBeVisible();
		await both(
			theo,
			async () => {
				await list();
				await expect(theo.getByRole('link', { name: 'Keep Theo' })).toBeVisible();
			},
			'sing-yours-guest'
		);

		await theo.goto('/settings/you');
		await theo.getByRole('button', { name: 'Keep me', exact: true }).click();
		await expect(theo.getByRole('heading', { name: 'Theo is kept on this phone' })).toBeVisible();
		await both(
			theo,
			async () => {
				await list();
				await expect(theo.getByRole('link', { name: 'Keep Theo' })).toHaveCount(0);
			},
			'sing-yours-kept'
		);
	} finally {
		await worker.stop();
	}
});
