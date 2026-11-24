// KEEP ME'S SURFACES (proposal 30, PR 2): the You tab before a first song, the offer after it, the kept card, the
// Delete me confirm, the "Welcome back" join, and the TV lobby, which accounts do not touch. `KEEP_SHOTS_OUT=<dir>`
// writes the PNGs there.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { readySong, singOnce } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SIZES = [
	{ width: 390, height: 844 },
	{ width: 320, height: 568 }
];

test('keep me: the You tab, Delete me, Welcome back, and the TV', async ({ world }, testInfo) => {
	test.setTimeout(240_000);
	const out = process.env.KEEP_SHOTS_OUT ?? testInfo.outputDir;
	mkdirSync(out, { recursive: true });

	async function shoot(page: Page, name: string): Promise<void> {
		await page.evaluate(() => document.fonts.ready.then(() => true));
		const path = join(out, `${name}.png`);
		await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
		await testInfo.attach(`${name}.png`, { path, contentType: 'image/png' });
	}
	async function both(page: Page, path: string, ready: () => Promise<void>, name: string): Promise<void> {
		for (const size of SIZES) {
			await page.setViewportSize(size);
			await page.goto(path);
			await ready();
			await shoot(page, `${name}-${size.width}`);
		}
	}

	const worker = await startFakeWorker(world);
	try {
		const tv = await world.openTv();
		const theo = await world.openPhone('Theo');
		const leave = () => expect(theo.getByRole('button', { name: 'Leave the room' })).toBeVisible();
		await both(theo, '/settings/you', leave, 'you-before-first-song');

		await readySong(world, theo, 'caroline');
		await theo.goto('/');
		await singOnce(theo, 'caroline');
		// After the song, as on the night: the 8 s fixture ends on its own and the You're up sheet goes with it.
		await expect(theo.locator(SEL.npStripTitle)).toHaveCount(0, { timeout: 30_000 });
		await both(
			theo,
			'/settings/you',
			() => expect(theo.getByRole('heading', { name: 'Keep Theo for next time' })).toBeVisible(),
			'you-keep-offer'
		);

		await theo.getByRole('button', { name: 'Keep me', exact: true }).click();
		const kept = () => expect(theo.getByRole('heading', { name: 'Theo is kept on this phone' })).toBeVisible();
		await kept();
		await both(theo, '/settings/you', kept, 'you-kept');

		for (const size of SIZES) {
			await theo.setViewportSize(size);
			await theo.goto('/settings/you');
			await theo.getByRole('button', { name: 'Delete me' }).click();
			await expect(theo.locator('[role="alertdialog"]')).toBeVisible();
			await shoot(theo, `you-delete-confirm-${size.width}`);
		}

		await theo.setViewportSize(SIZES[0]!);
		await theo.goto('/settings/you');
		await theo.getByRole('button', { name: 'Leave the room' }).click();
		await theo.getByRole('button', { name: 'Yes, leave' }).click();
		await theo.waitForURL((u) => u.pathname === '/');
		await both(
			theo,
			`/?room=${encodeURIComponent(world.code)}`,
			() => expect(theo.getByText('Welcome back')).toBeVisible(),
			'join-welcome-back'
		);
		await theo.getByRole('button', { name: "I'm someone else" }).click();
		await expect(theo.locator(SEL.nameInput)).toBeVisible();
		await shoot(theo, 'join-someone-else-320');

		await theo.setViewportSize(SIZES[0]!);
		await theo.goto(`/?room=${encodeURIComponent(world.code)}`);
		await theo.getByRole('button', { name: SEL.submit }).click();
		await theo.locator(SEL.search).waitFor();
		await shoot(theo, 'joined-as-theo-390');

		// The TV is unchanged: a kept singer is a name in their colour, like anyone else.
		await tv.locator(SEL.tvConnected).first().waitFor({ state: 'attached' });
		await shoot(tv, 'tv-with-kept-singer-1920');
	} finally {
		await worker.stop();
	}
});
