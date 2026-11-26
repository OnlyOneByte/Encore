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

async function openScreen(
	browser: Browser,
	world: World,
	w: number,
	h: number,
	real = false,
	touch = false
): Promise<Page> {
	const ctx = await browser.newContext({ viewport: { width: w, height: h }, baseURL: world.baseURL, hasTouch: touch });
	if (real) await ctx.addCookies([world.tvCookie]);
	const page = await ctx.newPage();
	// Every `tv:claim` this page sends, counted on its way out (and held back while `__holdClaims`), and when a press
	// began and last clicked, on the page's own clock.
	await page.addInitScript(() => {
		const w = window as unknown as PressLog;
		w.__claims = 0;
		w.__pressAt = w.__clickAt = null;
		const send = WebSocket.prototype.send;
		WebSocket.prototype.send = function (d) {
			if (typeof d === 'string' && d.includes('"tv:claim"')) {
				w.__claims++;
				if (w.__holdClaims) return;
			}
			return send.call(this, d);
		};
		for (const ev of ['pointerdown', 'keydown'])
			addEventListener(ev, () => (w.__pressAt ??= performance.now()), { capture: true, passive: true });
		addEventListener('click', () => (w.__clickAt = performance.now()), { capture: true, passive: true });
	});
	await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
	return page;
}
type PressLog = { __claims: number; __holdClaims?: boolean; __pressAt: number | null; __clickAt: number | null };
const claims = (p: Page) => p.evaluate(() => (window as unknown as PressLog).__claims);
/** The tv page drops a claim this soon after the press that woke the chip (CLAIM_AFTER_WAKE_MS). */
const CLAIM_AFTER_WAKE_MS = 500;
/** Where the claim button sits while it sleeps: `visibility: hidden` keeps its box. */
const buttonCentre = (p: Page) =>
	p.evaluate(() => {
		const r = document.querySelector('.copy-slot button')!.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	});
const shot = async (page: Page, name: string) => {
	if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
};
/** The lyric box's top and bottom: on a phone-shaped copy it must not move when the chip wakes or its line changes. */
const reelBox = (p: Page) =>
	p.evaluate(() => {
		const r = document.querySelector('.lyrics')!.getBoundingClientRect();
		return [Math.round(r.top), Math.round(r.bottom)];
	});
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
		for (const p of phones) await p.locator('.lyrics .row').first().waitFor({ timeout: 30_000 });
		const reelAsleep = await Promise.all(phones.map(reelBox));

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
		const reelAwake = await Promise.all(phones.map(reelBox));
		expect(reelAwake, 'the lyrics moved when the chip woke (390, 320)').toEqual(reelAsleep);
		// The shown line sits right-aligned against the button, as it did before the sizers, at both widths.
		for (const p of phones) {
			const [line, shown] = await p.evaluate(() =>
				['.copy-line', '.copy-line > span'].map((s) => document.querySelector(s)!.getBoundingClientRect().right)
			);
			expect(Math.abs(line! - shown!), `copy line right-aligned at ${p.viewportSize()!.width}`).toBeLessThan(1);
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
		// A longer line, which wraps at 320, still leaves the lyrics where they were (#1205).
		for (const p of phones) await expect(p.locator('.copy-line')).toHaveText('The TV is reconnecting...');
		for (const p of phones) await shot(p, `copy-${p.viewportSize()!.width}-reconnecting`);
		expect(await Promise.all(phones.map(reelBox)), 'the lyrics moved when the chip line changed').toEqual(reelAsleep);
	} finally {
		await worker.stop();
	}
});

// The review of #1195: a touch tap's click is hit-tested after the touch ends, by when the woken chip is back, and a
// double click's second half lands on it. Neither may claim; a deliberate press once the chip is up does.
test('no press that wakes a sleeping chip claims the TV; a press once it is up does', async ({ browser, world }) => {
	test.setTimeout(300_000);
	const worker = await startFakeWorker(world, { seconds: 120 });
	try {
		const tv = await openScreen(browser, world, 1920, 1080, true);
		const ana = await world.openPhone('Ana');
		await readySong(world, ana, 'caroline');
		const mouse = await openScreen(browser, world, 1920, 1080);
		const touch = await openScreen(browser, world, 1920, 1080, false, true);
		for (const p of [tv, mouse]) await p.mouse.click(5, 540);
		await touch.touchscreen.tap(5, 540);
		await queueReady(ana, 'caroline');
		for (const p of [mouse, touch]) await expect(p.locator(SEL.lowerThird)).toContainText(/Ana/, { timeout: 30_000 });

		const cases: [string, Page, (p: Page, at: { x: number; y: number }) => Promise<void>][] = [
			['a mouse click', mouse, (p, at) => p.mouse.click(at.x, at.y)],
			['a touch tap', touch, (p, at) => p.touchscreen.tap(at.x, at.y)],
			['a mouse double click', mouse, (p, at) => p.mouse.dblclick(at.x, at.y)],
			[
				'a touch double tap',
				touch,
				async (p, at) => {
					await p.touchscreen.tap(at.x, at.y);
					await p.waitForTimeout(120);
					await p.touchscreen.tap(at.x, at.y);
				}
			],
			['Enter', mouse, (p) => p.keyboard.press('Enter')],
			['Space', mouse, (p) => p.keyboard.press(' ')],
			[
				'a remote: ArrowDown, ArrowRight, Enter',
				mouse,
				async (p) => {
					for (const k of ['ArrowDown', 'ArrowRight', 'Enter']) await p.keyboard.press(k);
				}
			]
		];
		// A press is paced from here, so on a loaded host its last click can land past the window: that is a deliberate
		// press, not this case, so it is done again. Its claim is held back, so the seat stays put (#1225).
		for (const p of [mouse, touch]) await p.evaluate(() => ((window as unknown as PressLog).__holdClaims = true));
		for (const [name, p, act] of cases) {
			for (let attempt = 1; ; attempt++) {
				await asleep(p);
				const before = await claims(p);
				await p.evaluate(() => {
					const w = window as unknown as PressLog;
					w.__pressAt = w.__clickAt = null;
				});
				await act(p, await buttonCentre(p));
				await p.waitForTimeout(800);
				const took = await p.evaluate(() => {
					const { __pressAt: down, __clickAt: click } = window as unknown as PressLog;
					return down === null || click === null ? 0 : click - down;
				});
				if (took >= CLAIM_AFTER_WAKE_MS && attempt < 3) {
					console.log(`[p34] ${name} took ${Math.round(took)} ms in the page; pressing again`);
					continue;
				}
				expect(took, `${name} took too long in the page to be one press, 3 times`).toBeLessThan(CLAIM_AFTER_WAKE_MS);
				expect((await claims(p)) - before, `${name} on the sleeping chip's spot sent a claim`).toBe(0);
				await expect(p.locator(SLOT), `${name} moved the seat`).toBeAttached();
				break;
			}
		}
		for (const p of [mouse, touch]) await p.evaluate(() => ((window as unknown as PressLog).__holdClaims = false));

		// Up for 600 ms, the chip takes a tap: this screen becomes the TV.
		await asleep(touch);
		const at = await buttonCentre(touch);
		const held = await claims(touch);
		await touch.touchscreen.tap(5, 540);
		await awake(touch);
		await touch.waitForTimeout(600);
		await touch.touchscreen.tap(at.x, at.y);
		await expect(touch.locator(SLOT)).toHaveCount(0, { timeout: 5_000 });
		expect((await claims(touch)) - held).toBe(1);
	} finally {
		await worker.stop();
	}
});
