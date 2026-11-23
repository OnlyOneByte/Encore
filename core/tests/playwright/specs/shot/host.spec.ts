// THE HOST KEY'S SURFACES (proposal 30): what a guest sees on the room and machine settings, the /host door before
// and after the key, and the TV, which the key does not touch. `HOST_SHOTS_OUT=<dir>` writes the PNGs there.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('host: locked settings, the /host door, and the TV', async ({ world }, testInfo) => {
	const out = process.env.HOST_SHOTS_OUT ?? testInfo.outputDir;
	mkdirSync(out, { recursive: true });

	async function shoot(page: Page, name: string): Promise<void> {
		await page.evaluate(() => document.fonts.ready.then(() => true));
		const path = join(out, `${name}.png`);
		await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
		await testInfo.attach(`${name}.png`, { path, contentType: 'image/png' });
	}
	async function both(page: Page, path: string, ready: string, name: string): Promise<void> {
		for (const width of [390, 320]) {
			await page.setViewportSize({ width, height: 844 });
			await page.goto(path);
			await expect(page.locator(ready).first()).toBeVisible();
			await shoot(page, `${name}-${width}`);
		}
	}

	const tv = await world.openTv();
	const ana = await world.openPhone('Ana');
	await tv.locator(SEL.tvConnected).first().waitFor({ state: 'attached' });
	await shoot(tv, 'tv-lobby-1920');

	await both(ana, '/settings', '#host-only', 'settings-guest');
	await both(ana, '/settings/server', '#host-only', 'settings-server-guest');
	await both(ana, '/host', '#host-off', 'host-guest');

	await world.becomeHost(ana);
	await both(ana, '/host', '#host-on', 'host-host');
	await both(ana, '/settings', '#rotation', 'settings-host');
	await expect(ana.locator('#host-only')).toHaveCount(0);
});
