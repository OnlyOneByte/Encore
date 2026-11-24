// P34 PR 2: a copy is a room screen. Mid-song it has the join QR in its corner like the TV, and its chip ("This screen
// is quiet / Make this the TV") shows only for 20 s after the screen opens and 10 s after a tap or a key, standing in
// "Up next"'s place. Idle, nothing on stage asks to be pressed (tenet 6). The lobby keeps the chip, a copy whose TV
// has gone keeps it, and a first tap only wakes it, never claims. `SHOT_DIR=<dir>` also writes each state's frame.
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { readySong, queueReady } from '../../world/actors';
import { SEL } from '../../world/selectors';
import type { Browser, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

const SLOT = '.copy-slot';
const CHIP = '.copy-chip';
const CLAIM = { name: 'Make this the TV' };

async function openScreen(browser: Browser, world: World, w: number, h: number, real = false): Promise<Page> {
	const ctx = await browser.newContext({ viewport: { width: w, height: h }, baseURL: world.baseURL });
	if (real) await ctx.addCookies([world.tvCookie]);
	const page = await ctx.newPage();
	await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
	return page;
}
const shot = async (page: Page, name: string) => {
	if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
};
const asleep = (p: Page) => expect(p.locator(`${SLOT}.asleep`)).toBeAttached({ timeout: 30_000 });
const awake = (p: Page) => expect(p.locator(`${SLOT}:not(.asleep) ${CHIP}`)).toBeVisible();

test('a copy mid-song is a room screen: its QR in the corner, and the chip only for a while after it opens or a tap', async ({
	browser,
	world
}) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { seconds: 90 });
	try {
		const tv = await openScreen(browser, world, 1920, 1080, true);
		const ana = await world.openPhone('Ana');
		await world.openPhone('Bo');
		await readySong(world, ana, 'caroline');
		await readySong(world, ana, 'bohemian');
		const copy = await openScreen(browser, world, 1920, 1080);
		const phones = [await openScreen(browser, world, 390, 844), await openScreen(browser, world, 320, 568)];
		const copies = [copy, ...phones];

		// The lobby keeps the chip, in the QR's place, past the 20 s a stage would give it.
		await expect(copy.locator('.lobby')).toBeVisible({ timeout: 15_000 });
		await copy.waitForTimeout(21_000);
		await expect(copy.locator(`.lobby ${CHIP}`)).toBeVisible();
		await shot(copy, 'copy-1920-lobby');

		for (const p of [tv, ...copies]) await p.mouse.click(p.viewportSize()!.width / 2, p.viewportSize()!.height / 2);
		await queueReady(ana, 'caroline');
		await queueReady(ana, 'bohemian');
		for (const p of copies) await expect(p.locator(SEL.lowerThird)).toContainText(/Ana/, { timeout: 30_000 });
		for (const p of copies) await expect(p.locator(SEL.stateNext)).toHaveCount(0, { timeout: 15_000 });

		// Idle mid-song: no chip on stage, and on a TV-shaped copy the join QR in the corner and "Up next" in its place,
		// as on the TV. A phone reading along has joined already and keeps its corner clear.
		for (const p of copies) {
			await asleep(p);
			await expect(p.locator(CHIP)).toBeHidden();
			await expect(p.getByRole('button', CLAIM)).toHaveCount(0);
		}
		await expect(copy.locator('.corner')).toBeVisible();
		for (const p of phones) await expect(p.locator('.corner')).toBeHidden();
		await expect(copy.locator('.upnext')).toBeVisible();
		await shot(copy, 'copy-1920-idle');
		await shot(tv, 'tv-1920');
		await shot(phones[0]!, 'copy-390-idle');
		await shot(phones[1]!, 'copy-320-idle');

		// A tap wakes it top-right, in "Up next"'s place, and does not claim: the seat and the sound stay on the TV.
		await copy.mouse.click(960, 540);
		const tappedAt = Date.now();
		await awake(copy);
		await expect(copy.locator('.upnext')).toBeHidden();
		const [chip, dot] = await copy.evaluate(
			(q) => q.map((s) => document.querySelector(s)!.getBoundingClientRect().toJSON()),
			[SLOT, '.status']
		);
		expect(chip.top, 'the chip sits below the connection dot').toBeGreaterThanOrEqual(dot.bottom - 0.5);
		expect(chip.right, 'the chip is in the top-right corner').toBeGreaterThan(1920 * 0.75);
		expect(chip.bottom, 'the chip is in the top band').toBeLessThan(1080 * 0.25);
		await expect(tv.locator(CHIP)).toHaveCount(0);
		await expect(copy.locator(CHIP)).toContainText('This screen is quiet');
		await shot(copy, 'copy-1920-tap');
		for (const p of phones) {
			await p.mouse.click(p.viewportSize()!.width / 2, p.viewportSize()!.height / 2);
			await awake(p);
			// Across a narrow phone "Up next" is the chip's neighbour, so it steps aside there too.
			await expect(p.locator('.upnext')).toBeHidden();
			await shot(p, `copy-${p.viewportSize()!.width}-tap`);
		}

		// Ten seconds after the tap it sleeps again, and "Up next" is back.
		const left = tappedAt + 8_000 - Date.now();
		if (left > 0) {
			await copy.waitForTimeout(left);
			await awake(copy);
		}
		await asleep(copy);
		expect(Date.now() - tappedAt, 'the chip slept well after its 10 s').toBeLessThan(13_000);
		await expect(copy.locator('.upnext')).toBeVisible();

		// A key wakes it too, and then the claim is one Tab away.
		await copy.keyboard.press('Shift');
		await awake(copy);
		await copy.getByRole('button', CLAIM).focus();
		await expect(copy.getByRole('button', CLAIM)).toBeFocused();

		// The TV goes: the copy says so and keeps the chip up while it lasts, whatever the timer says.
		await asleep(copy);
		await tv.context().close();
		await expect(copy.locator(CHIP)).toContainText('The TV is reconnecting...', { timeout: 5_000 });
		await expect(copy.locator(CHIP)).toBeVisible();
	} finally {
		await worker.stop();
	}
});
