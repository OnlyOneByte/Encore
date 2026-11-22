// YOUR CARD COMES TO YOU (proposal 13, 2/2), at 320x568 where no dock height is enough: the Now card alone reaches
// y 506, so Theo's On deck heads-up card starts at 514, under the dock's top edge (475), and his failed card's × is
// off screen. When either needs him, /queue scrolls that card up once so its first control lies between the sticky
// header's bottom and the dock's top. A touch in the 3 s before means the guest is driving: no scroll.
import { test, expect } from '../../world/fixtures';
import { DEMO_LIBRARY } from '../../world/seed';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue, queueReady, readySong } from '../../world/actors';
import type { Page } from '@playwright/test';

/** Past the 30 s heads-up window by a few seconds, so each test waits a little for it. */
const SECS = 40;
test.use({ demoLibrary: [DEMO_LIBRARY.map((t) => ({ ...t, seconds: SECS })), { scope: 'test' }] });

/** Where the card's first control sits against the header and the dock, and how far the page has scrolled. */
const reach = (page: Page, card: string) =>
	page.evaluate((sel) => {
		const c = document.querySelector(sel)?.querySelector('button')?.getBoundingClientRect();
		return {
			top: c?.top ?? NaN,
			bottom: c?.bottom ?? NaN,
			header: document.querySelector('.page-header')!.getBoundingClientRect().bottom,
			dock: document.querySelector('.dock')!.getBoundingClientRect().top,
			scrollY: Math.round(window.scrollY)
		};
	}, card);
const reachable = (r: Awaited<ReturnType<typeof reach>>) => r.top >= r.header && r.bottom <= r.dock;

async function theoOnDeck(world: Parameters<Parameters<typeof test>[2]>[0]['world']) {
	const worker = await startFakeWorker(world, { seconds: SECS });
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	await theo.setViewportSize({ width: 320, height: 568 });
	await readySong(world, maya, 'caroline');
	await readySong(world, maya, 'believin');
	await world.openTv();
	await queueReady(maya, 'caroline');
	await queueReady(theo, 'believin');
	await openQueue(theo);
	await expect(theo.locator('.deck')).toBeVisible({ timeout: 10_000 });
	await theo.evaluate(() => window.scrollTo(0, 0));
	return { worker, maya, theo };
}

test('320x568: the heads-up card comes up so its key clears the dock', async ({ world }) => {
	const { worker, maya, theo } = await theoOnDeck(world);
	try {
		expect(reachable(await reach(theo, '.deck')), 'positive control: the card starts under the dock').toBe(false);
		await expect(theo.locator('.deck.heads-up')).toBeVisible({ timeout: SECS * 1_000 });
		await expect.poll(async () => reachable(await reach(theo, '.deck')), { timeout: 3_000 }).toBe(true);
		const r = await reach(theo, '.deck');
		expect(r.scrollY, 'the page scrolled').toBeGreaterThan(0);
		// Once per entry: the guest scrolls back up and the page leaves them there — past the 3 s quiet window too,
		// and after the queue changes under them (Maya adds a turn), which re-runs the decision.
		await theo.mouse.wheel(0, -2_000);
		await theo.waitForTimeout(3_500);
		await queueReady(maya, 'caroline');
		await theo.waitForTimeout(1_500);
		expect((await reach(theo, '.deck')).scrollY, 'it scrolled a second time for the same card').toBe(0);
	} finally {
		await worker.stop();
	}
});

test('320x568: a touch in the 3 s before the heads-up keeps the page where the guest has it', async ({ world }) => {
	const { worker, theo } = await theoOnDeck(world);
	try {
		// A real wheel of nothing, every second until the heads-up: input that moves no pixel.
		const deadline = Date.now() + SECS * 1_000;
		while (!(await theo.locator('.deck.heads-up').count()) && Date.now() < deadline) {
			await theo.mouse.move(160, 200);
			await theo.mouse.wheel(0, 0);
			await theo.waitForTimeout(1_000);
		}
		await expect(theo.locator('.deck.heads-up')).toBeVisible();
		await theo.waitForTimeout(1_500);
		expect((await reach(theo, '.deck')).scrollY, 'the page moved under a guest who was touching it').toBe(0);
	} finally {
		await worker.stop();
	}
});

test('320x568: under reduced motion the card comes up in one jump, not a glide', async ({ world }) => {
	const { worker, theo } = await theoOnDeck(world);
	try {
		await theo.emulateMedia({ reducedMotion: 'reduce' });
		// Every frame's scrollY, from before the heads-up until the page is still.
		await theo.evaluate(() => {
			const w = window as unknown as { __ys: number[] };
			w.__ys = [];
			const tick = () => {
				w.__ys.push(Math.round(window.scrollY));
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		await expect(theo.locator('.deck.heads-up')).toBeVisible({ timeout: SECS * 1_000 });
		await expect.poll(async () => reachable(await reach(theo, '.deck')), { timeout: 3_000 }).toBe(true);
		await theo.waitForTimeout(800);
		const ys = await theo.evaluate(() => (window as unknown as { __ys: number[] }).__ys);
		const end = ys.at(-1)!;
		expect(end, 'the page scrolled').toBeGreaterThan(0);
		// A smooth scroll passes through values between 0 and the target (measured 0, 2, 33, 235, 412, 432).
		expect(
			[...new Set(ys)].filter((y) => y !== 0 && y !== end),
			'scroll positions between the start and the target: the scroll glided under reduced motion'
		).toEqual([]);
	} finally {
		await worker.stop();
	}
});

test('320x568: opening Queue by its tab while you are up next brings the card up', async ({ world }) => {
	// The tap that opens /queue lands on the PREVIOUS page, before /queue's input listeners exist, so it is not
	// "the guest driving": being buzzed and then opening Queue is the path that most needs the card.
	const { worker, theo } = await theoOnDeck(world);
	const watch = await theo.context().newPage();
	try {
		await watch.setViewportSize({ width: 320, height: 568 });
		await watch.goto('/queue');
		await theo.getByRole('link', { name: 'Library', exact: true }).click();
		await theo.waitForURL(/\/library$/);
		await expect(watch.locator('.deck.heads-up')).toBeVisible({ timeout: SECS * 1_000 });
		await theo.getByRole('link', { name: 'Queue', exact: true }).click();
		await theo.waitForURL(/\/queue$/);
		await expect(theo.locator('.deck.heads-up')).toBeVisible();
		await expect.poll(async () => reachable(await reach(theo, '.deck')), { timeout: 5_000 }).toBe(true);
		expect((await reach(theo, '.deck')).scrollY, 'the page scrolled').toBeGreaterThan(0);
	} finally {
		await watch.close();
		await worker.stop();
	}
});

test('320x568: a reload during your heads-up brings the card up (the phone woke from sleep)', async ({ world }) => {
	// A hard load: since #996 the page mounts after SvelteKit's first navigation has finished, so `afterNavigate`
	// never fires for it. A browser that discarded the tab while the phone slept does exactly this.
	const { worker, theo } = await theoOnDeck(world);
	try {
		await expect(theo.locator('.deck.heads-up')).toBeVisible({ timeout: SECS * 1_000 });
		// At the top BEFORE the reload, so the page comes back at 0. A scrollTo after the reload would race the
		// bring-up and could wipe it, failing the test for the wrong reason.
		await theo.mouse.wheel(0, -2_000);
		await theo.evaluate(() => window.scrollTo(0, 0));
		await theo.waitForTimeout(500);
		await theo.reload();
		await expect(theo.locator('.deck.heads-up')).toBeVisible({ timeout: 10_000 });
		await expect.poll(async () => reachable(await reach(theo, '.deck')), { timeout: 5_000 }).toBe(true);
		expect((await reach(theo, '.deck')).scrollY, 'the page scrolled').toBeGreaterThan(0);
	} finally {
		await worker.stop();
	}
});

test('320x568: a hold animating the card as it turns heads-up is waited out, so the card still lands right', async ({
	world
}) => {
	// The shape of #1002's settle: something holds the card away from its layout position with a transform, in the
	// frame it turns heads-up. A rect read during the hold is off by the hold (here 200 px up), and the card would
	// then land 200 px wrong or not move at all. The hold starts a second before the heads-up, from the Now card's
	// own countdown, so the test does not race the page's observer.
	const { worker, theo } = await theoOnDeck(world);
	try {
		await theo.evaluate(() => {
			const tick = () => {
				const left = document.querySelector('.now')?.textContent ?? '';
				const deck = document.querySelector<HTMLElement>('.deck');
				// "−0:31" shows for the last second before the 30 s heads-up (the clock rounds up), and the hold
				// outlasts it by about 1.5 s.
				if (deck && /−0:31\b/.test(left)) {
					deck.animate([{ transform: 'translateY(-200px)' }, { transform: 'translateY(-200px)' }], {
						duration: 2_500
					});
					return;
				}
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		await expect(theo.locator('.deck.heads-up')).toBeVisible({ timeout: SECS * 1_000 });
		// The hold was running when the heads-up landed: it started inside the 2 s before it.
		const holding = await theo.evaluate(() =>
			document
				.querySelector('.deck')!
				.getAnimations()
				.some((a) => (a.effect as KeyframeEffect).getKeyframes().some((k) => !!k.transform))
		);
		expect(holding, 'positive control: the hold was running as the heads-up landed').toBe(true);
		// Past the hold, then past the smooth scroll it released.
		await theo.waitForTimeout(3_500);
		const r = await reach(theo, '.deck');
		expect(reachable(r), `after the hold the card's key must clear the dock: ${JSON.stringify(r)}`).toBe(true);
		expect(r.scrollY, 'the page scrolled').toBeGreaterThan(0);
	} finally {
		await worker.stop();
	}
});

test('320x568: your song that cannot be made comes up so its × clears the dock', async ({ world }) => {
	// Theo has ONLY the failing song, so no heads-up competes for the scroll. Maya's Now card fills the screen above it.
	const worker = await startFakeWorker(world, { seconds: SECS });
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	await theo.setViewportSize({ width: 320, height: 568 });
	await readySong(world, maya, 'caroline');
	await world.openTv();
	await queueReady(maya, 'caroline');
	await worker.stop();
	// Theo queues with NO worker attached, so the song waits; his own taps are then past the 3 s quiet window before
	// the failing worker joins. Otherwise the fake failure lands inside it and the page rightly stays put.
	await theo.goto('/');
	await openBrowseFromHome(theo);
	await theo.locator(SEL.search).fill('bohemian');
	await theo.locator(`${SEL.addTurn}, ${SEL.sing}`).first().click();
	await openQueue(theo);
	await theo.evaluate(() => window.scrollTo(0, 0));
	await theo.waitForTimeout(3_500);
	const bad = await startFakeWorker(world, { seconds: SECS, workerId: 'bad-1', fail: 'stems' });
	try {
		await expect(theo.locator(SEL.failedTurn)).toBeAttached({ timeout: 60_000 });
		await expect.poll(async () => reachable(await reach(theo, SEL.failedTurn)), { timeout: 5_000 }).toBe(true);
		expect((await reach(theo, SEL.failedTurn)).scrollY, 'the page scrolled').toBeGreaterThan(0);
	} finally {
		await bad.stop();
		await worker.stop().catch(() => {});
	}
});
