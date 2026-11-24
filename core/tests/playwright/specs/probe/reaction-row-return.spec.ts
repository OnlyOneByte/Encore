// THE CHEER KEY COMES BACK. dock-cls.spec.ts proves the singer's Cheer key RESTS when their song starts (same slot,
// faded, inert). This is the other leg: Maya, Theo, Maya — Theo's key rests for his song and must
// be live again for Maya's next one. It is one prop flip, so a key stuck resting (`inert` left on, `visibility`
// never restored) is possible, and nothing else would notice.
// While resting it must also be gone for every input: not hit-testable, not focusable, and absent from Chrome's own
// accessibility tree. Both motion modes, because the rest is a fade that `reduce` skips.
import type { Page } from '@playwright/test';
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { queueReady, readySong } from '../../world/actors';
import { SETTLE_MS } from '../../../../src/lib/transport-target';

async function watchShifts(p: Page): Promise<void> {
	await p.evaluate(() => {
		const w = window as unknown as { __shifts: number[] };
		w.__shifts = [];
		new PerformanceObserver((l) => {
			for (const e of l.getEntries() as unknown as { value: number }[]) w.__shifts.push(e.value);
		}).observe({ type: 'layout-shift', buffered: false });
	});
}
const shifts = (p: Page) => p.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts);

/** Maya pauses the room and `seen` shows it. The fixture songs last 8 s, which a slow box can spend on the checks
 *  for one song, and the song then ends by itself before the skip under test (#1219). A pause names no song. */
async function pause(maya: Page, seen: Page): Promise<void> {
	await maya.locator(SEL.npPlayPause).click();
	await expect(seen.locator(SEL.npPlayPause)).toHaveAttribute('aria-label', 'Play');
}

/** Chrome's own AX tree (not Playwright's snapshot): the unignored nodes named like a cheer or the cheer group. */
async function axCheers(p: Page): Promise<string[]> {
	const cdp = await p.context().newCDPSession(p);
	const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
		nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[];
	};
	await cdp.detach();
	const named = /Cheer for|^(Clap|Fire|Laugh|Love|Heart|Applause)/i;
	return nodes
		.filter((n) => !n.ignored && named.test(n.name?.value ?? ''))
		.map((n) => `${n.role?.value}:${n.name?.value}`);
}

/** The classes keyboard focus lands on over 40 Tabs from the top of the page. */
async function tabStops(p: Page): Promise<string[]> {
	await p.locator('body').click({ position: { x: 5, y: 5 } });
	const seen: string[] = [];
	for (let i = 0; i < 40; i++) {
		await p.keyboard.press('Tab');
		seen.push(await p.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? ''));
	}
	return seen;
}

for (const reduce of [false, true]) {
	test(`the singer's Cheer key rests for their song and comes back after it (reduced motion: ${reduce})`, async ({
		world
	}) => {
		const worker = await startFakeWorker(world);
		try {
			const maya = await world.openPhone('Maya');
			const theo = await world.openPhone('Theo');
			const ana = await world.openPhone('Ana');
			await theo.setViewportSize({ width: 320, height: 844 });
			if (reduce) await theo.emulateMedia({ reducedMotion: 'reduce' });
			for (const q of ['caroline', 'believin', 'prayer']) await readySong(world, maya, q);
			await world.openTv();
			await queueReady(maya, 'caroline');
			await queueReady(theo, 'believin');
			await queueReady(maya, 'prayer');
			await expect(theo.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 30_000 });
			await pause(maya, theo);
			// Past the playhead's first second and the strip's settle window, as dock-cls does.
			await theo.waitForTimeout(3_000);
			await watchShifts(theo);
			const dock = theo.locator(SEL.dock);
			const before = await dock.boundingBox();

			// Theo's song: his key rests. Ana, a fan of both songs, has the tray open as it changes: it must close,
			// because its label named Maya. Maya skips, since Ana's transport is under her tray.
			await ana.locator(SEL.npCheerKey).click({ timeout: 5_000 });
			await expect(ana.locator(SEL.npCheers)).toHaveCount(1);
			await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
			await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i, { timeout: 5_000 });
			await expect(ana.locator(SEL.npStripTitle)).toContainText(/believin/i, { timeout: 5_000 });
			await pause(maya, theo);
			// One-shot, not retrying: the tray's own 6 s timer would satisfy a retrying assertion.
			expect(await ana.locator(SEL.npCheers).count(), 'the tray stayed open across a song change').toBe(0);
			await expect(theo.locator(SEL.npCheerKey)).toHaveAttribute('inert');
			// "You're up" closes on its own timer, so a tap on OK can race it. Paused, no new one opens.
			await expect(theo.getByRole('button', { name: 'OK' })).toBeHidden();
			await expect(theo.locator(SEL.npCheerKey)).toHaveCSS('visibility', 'hidden');
			expect(await axCheers(theo), 'cheers Chrome exposes to assistive tech while resting').toEqual([]);
			const box = (await theo.locator(SEL.npCheerKey).boundingBox())!;
			const hit = await theo.evaluate(
				([x, y]) => document.elementFromPoint(x, y)?.closest('.cheer-key') !== null,
				[box.x + box.width / 2, box.y + box.height / 2]
			);
			expect(hit, 'a resting Cheer key is hit-testable').toBe(false);
			expect(
				(await tabStops(theo)).filter((c) => c.includes('cheer')),
				'a resting Cheer key takes focus'
			).toEqual([]);
			// The audience at the same moment: live.
			await expect(ana.locator(SEL.npCheerKey)).not.toHaveAttribute('inert');
			await expect(ana.locator(SEL.npCheerKey)).toHaveCSS('opacity', '1');

			// Maya's next song: Theo is back in the audience, and so is his key. A phone drops a skip tapped within
			// SETTLE_MS of its strip changing (one skip per tap), and Ana's changed before the checks above (#1219).
			await ana.waitForTimeout(SETTLE_MS);
			await ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
			await expect(theo.locator(SEL.npStripTitle)).toContainText(/prayer|livin/i, { timeout: 5_000 });
			await pause(maya, theo);
			await expect(theo.locator(SEL.npCheerKey)).not.toHaveAttribute('inert');
			await expect(theo.locator(SEL.npCheerKey)).toHaveCSS('opacity', '1');
			await expect(theo.locator(SEL.npCheerKey)).toHaveCSS('visibility', 'visible');
			expect((await axCheers(theo)).length, 'the live key is back in the accessibility tree').toBeGreaterThan(0);
			expect(
				(await tabStops(theo)).filter((c) => c.includes('cheer')).length,
				'the live key takes focus'
			).toBeGreaterThan(0);
			// Real pointer taps: Playwright's actionability check refuses an element hit-testing does not reach.
			await theo.locator(SEL.npCheerKey).click({ timeout: 5_000 });
			await theo.locator(SEL.npCheer).first().click({ timeout: 5_000 });
			expect(await shifts(theo), 'layout shift over the round trip').toEqual([]);
			expect(await dock.boundingBox()).toEqual(before);
		} finally {
			await worker.stop();
		}
	});
}
