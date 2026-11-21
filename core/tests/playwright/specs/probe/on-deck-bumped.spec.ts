// ON DECK NEVER MOVES WITHOUT A WORD (proposal 14, part 3), in a real room: a TV and three phones. Maya is singing.
// Ana queued `prayer` first, but no worker is connected, so it is still being made and Theo's ready `believin` is On
// deck. Theo sets -1. Then a worker connects and finishes Ana's song: it was ahead of him, so it goes first — fair,
// and before this change Theo's card simply vanished with nothing said on any phone. Now his phone says "Ana's going
// first. You're next." on whatever tab it is on, once, and his -1 is still there when his turn comes back.
import { test, expect } from '../../world/fixtures';
import { DEMO_LIBRARY } from '../../world/seed';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue, queueReady, readySong } from '../../world/actors';
import type { Page } from '@playwright/test';

const SECS = 60;
const ON_DECK = 'section[aria-label="On deck"]';
const TOAST = '[data-sonner-toast]';
test.use({ demoLibrary: [DEMO_LIBRARY.map((t) => ({ ...t, seconds: SECS })), { scope: 'test' }] });

/** Queue a song that is not made yet: the Sing action queues the turn and starts making it. */
async function queueCooking(phone: Page, q: string): Promise<void> {
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(q);
	await phone.locator(`${SEL.addTurn}, ${SEL.sing}`).first().click();
	await expect(phone.locator(SEL.dock).first()).toBeVisible();
}

test('a song ahead finishing being made takes On deck, and Theo is told once, on any tab, with his key kept', async ({
	world
}, testInfo) => {
	test.setTimeout(7 * 60_000);
	const shoot = (step: string, pages: Record<string, Page>) =>
		Promise.all(Object.entries(pages).map(([n, p]) => p.screenshot({ path: testInfo.outputPath(`${step}-${n}.png`) })));
	let worker = await startFakeWorker(world, { seconds: SECS });
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		for (const q of ['caroline', 'believin']) await readySong(world, maya, q);
		const tv = await world.openTv();
		await queueReady(maya, 'caroline');
		await expect(tv.locator(SEL.stateNext)).toBeHidden({ timeout: 30_000 });
		// No worker from here, so Ana's song stays in the making, ahead of Theo's in the rotation.
		await worker.stop();
		await queueCooking(ana, 'prayer');
		await queueReady(theo, 'believin');
		for (const p of [maya, ana]) await openQueue(p);
		await openQueue(theo);

		// Theo's phone records every heads-up buzz (the 60/40/60 pattern), so the re-arm can be seen.
		await theo.evaluate(() => {
			const w = window as unknown as { __buzz: number };
			w.__buzz = 0;
			Object.defineProperty(navigator, 'vibrate', {
				configurable: true,
				value: (p: number | number[]) => (Array.isArray(p) && p.join() === '60,40,60' && w.__buzz++, true)
			});
		});
		const buzzes = () => theo.evaluate(() => (window as unknown as { __buzz: number }).__buzz);
		const deck = theo.locator(ON_DECK);
		await expect(deck).toBeVisible({ timeout: 10_000 });
		await deck.getByRole('button', { name: 'Lower by one semitone' }).click();
		await expect(deck).toContainText('−1');
		await expect(tv.locator('.upnext')).toContainText('Theo');
		// Maya's song reaches its last 30 s: Theo's heads-up buzzes, once.
		await expect(theo.locator(`${ON_DECK}.heads-up`)).toBeVisible({ timeout: 60_000 });
		await expect.poll(buzzes).toBe(1);
		// Theo goes to another tab on the smallest phone: the line must reach him there, clear of the dock (IN-04).
		await theo.setViewportSize({ width: 320, height: 568 });
		await theo.locator(SEL.tab).filter({ hasText: 'Library' }).first().click();
		await expect(theo.locator(TOAST)).toHaveCount(0);
		await shoot('before', { tv, maya, theo, ana });
		// Count every time the line is SAID: sonner updates a toast in place by id, so a count of nodes cannot.
		await theo.evaluate(() => {
			const w = window as unknown as { __bumps: string[] };
			w.__bumps = [];
			let last = '';
			new MutationObserver(() => {
				const t = [...document.querySelectorAll('[data-sonner-toast]')].map((e) => e.textContent ?? '').join('|');
				if (t.includes('going first') && t !== last) w.__bumps.push(t);
				last = t;
			}).observe(document.body, { subtree: true, childList: true, characterData: true });
		});

		worker = await startFakeWorker(world, { seconds: SECS });
		// Ana's song is made, and it was ahead: the room moves On deck to her (fair), on main and here alike.
		await expect(tv.locator('.upnext')).toContainText('Ana', { timeout: 90_000 });
		const toast = theo.locator(TOAST, { hasText: 'going first' });
		await expect(toast).toHaveText(/Ana’s going first\. You’re next\./);
		await shoot('bumped', { tv, maya, theo, ana });
		// The overlap meter: the toast's box against the dock's and the On deck card's, in px of shared area.
		const overlap = await theo.evaluate(() => {
			const box = (s: string) => document.querySelector(s)?.getBoundingClientRect() ?? null;
			const t = [...document.querySelectorAll('[data-sonner-toast]')].find((e) => e.textContent?.includes('going'));
			const toastBox = t?.getBoundingClientRect() ?? null;
			const area = (b: DOMRect | null) =>
				!toastBox || !b
					? 0
					: Math.max(0, Math.min(toastBox.right, b.right) - Math.max(toastBox.left, b.left)) *
						Math.max(0, Math.min(toastBox.bottom, b.bottom) - Math.max(toastBox.top, b.top));
			return {
				toast: toastBox?.toJSON(),
				dock: area(box('.dock')),
				onDeck: area(box('section[aria-label="On deck"]'))
			};
		});
		testInfo.annotations.push({ type: 'overlap', description: JSON.stringify(overlap) });
		expect(overlap.toast, 'the toast is on screen').toBeTruthy();
		expect(overlap).toMatchObject({ dock: 0, onDeck: 0 });
		// Nobody else is told anything, and the line names who goes first, never who moved anything.
		for (const p of [maya, ana]) await expect(p.locator(TOAST, { hasText: 'going first' })).toHaveCount(0);
		// Once: the next room updates do not say it again.
		await theo.waitForTimeout(5_000);
		expect(await theo.evaluate(() => (window as unknown as { __bumps: string[] }).__bumps.length)).toBe(1);

		// Ana's turn, then Theo's card comes back with his -1.
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await theo.setViewportSize({ width: 390, height: 844 });
		await openQueue(theo);
		await expect(theo.locator(ON_DECK)).toBeVisible({ timeout: 20_000 });
		await expect(theo.locator(ON_DECK)).toContainText('−1');
		await expect(theo.locator(TOAST, { hasText: 'going first' })).toHaveCount(0, { timeout: 10_000 });
		await shoot('after', { tv, maya, theo, ana });
		// The heads-up buzz was RE-ARMED when he lost On deck: Ana's last 30 s buzz his phone again.
		await expect(theo.locator(`${ON_DECK}.heads-up`)).toBeVisible({ timeout: SECS * 1000 });
		await expect.poll(buzzes).toBe(2);
	} finally {
		await worker.stop().catch(() => {});
	}
});
