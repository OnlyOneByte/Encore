// THE QUEUE TAB HOLDS STILL WHEN THE NOW-SINGING CARD COMES AND GOES. Theo watches /queue on his phone in an idle
// room. Maya takes a turn, the room starts its FIRST song, and the card appears at the top of the page: everything
// under it used to jump down by the card's height in one frame. The opposite moment is the same jump upwards: the
// song is skipped, nothing playable is left, and the card leaves (CLS about 0.31 at 390 on main). Nobody on Theo's
// phone touches anything, so every entry counts. Two rooms: an empty queue (the empty state is what sits under the
// card) and one where Theo's own song is still cooking (a queue row is).
//
// THE PAGE, NOT THE DOCK. The fixed dock also shifts as the first song starts, because the now-playing strip joins
// it and its top edge rises (about 0.026). That is the phone layout's, on every tab, so it is filtered out here by
// source and reported separately; an entry that names anything inside `main` fails.
//
// NOR A ROW'S OWN CONTENT. Maya's turn reaches the queue a beat before it starts playing, so for about 100 ms Theo's
// cooking row has a neighbour, grows its reorder grip, and its number and title slide sideways (about 0.002), then
// back when the turn leaves for the card. That is the transient row, not the card, and it is on main too. The row
// BOX moving, which is what the card used to do to it, still fails.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { goOffline, openBrowseFromHome, openQueue, queueReady, readySong, transportTap } from '../../world/actors';
import type { Page } from '@playwright/test';

type Shift = { value: number; sources: string[] };
type Watch = {
	shifts: Shift[];
	before: number;
	firstFrame: number | null;
	cardAnimation: string | null;
	covered: number;
};

/**
 * From now on: every layout-shift entry whose sources include something inside `main`, and where the first block
 * under the card's slot is DRAWN on the first frame after the card comes or goes, against where it was drawn before.
 * Whatever that block is (the empty state, the heading over the rows), and even when it was replaced meanwhile:
 * Maya's turn sits in the queue for a beat before it starts, so the empty state is swapped out and back.
 * The second half is not redundant. Chromium files no layout shift for an element with a running transform
 * animation, whatever the animation's distance, so the CLS half alone passes a hold that holds it in the wrong place.
 * And `covered`: for 700 ms after the card arrives, the most of the content it was drawn over, as its opacity times
 * the px the two boxes overlap. The content eases down THROUGH the card's box, so a card that is visible meanwhile
 * draws two legible layers of text.
 */
async function watchPage(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { __watch: Watch; __obs?: PerformanceObserver; __mo?: MutationObserver };
		const main = document.querySelector('main')!;
		// The Now row and your card are blocks of `.below`; the block under them is whatever follows.
		const box = main.querySelector(':scope > .below')!;
		const firstUnder = () => [...box.children].find((c) => !c.matches('.now, .deck'));
		const top = () => firstUnder()!.getBoundingClientRect().top;
		w.__obs?.disconnect();
		w.__mo?.disconnect();
		w.__watch = { shifts: [], before: top(), firstFrame: null, cardAnimation: null, covered: 0 };
		w.__obs = new PerformanceObserver((list) => {
			for (const e of list.getEntries() as unknown as { value: number; sources: { node?: Node | null }[] }[]) {
				// A source INSIDE a row is the row's own content moving sideways, never the card's push (which moves
				// the row box itself). See the note at the top.
				const inPage = e.sources.filter(
					(s) => !!s.node && main.contains(s.node) && !(s.node as Element).parentElement?.closest('.qrow')
				);
				if (inPage.length)
					w.__watch.shifts.push({
						value: e.value,
						sources: inPage.map((s) => (s.node as Element).className?.toString() ?? '?')
					});
			}
		});
		w.__obs.observe({ type: 'layout-shift', buffered: false });
		// The card is a direct child of `.below`; a row coming or going is a mutation further down.
		w.__mo = new MutationObserver(() => {
			if (w.__watch.firstFrame !== null || !!document.querySelector('main > .below > .now') === hadCard) return;
			requestAnimationFrame(() => {
				w.__watch.firstFrame ??= top();
				const card = document.querySelector('main > .below > .now');
				w.__watch.cardAnimation ??= card ? getComputedStyle(card).animationName : null;
			});
			if (hadCard) return;
			const until = performance.now() + 700;
			const sample = () => {
				const card = document.querySelector('main > .below > .now');
				const under = firstUnder();
				if (card && under) {
					const a = card.getBoundingClientRect();
					const b = under.getBoundingClientRect();
					const px = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
					const covered = Number(getComputedStyle(card).opacity) * px;
					w.__watch.covered = Math.max(w.__watch.covered, covered);
				}
				if (performance.now() < until) requestAnimationFrame(sample);
			};
			requestAnimationFrame(sample);
		});
		const hadCard = !!document.querySelector('main > .below > .now');
		w.__mo.observe(box, { childList: true });
	});
}

const watchOf = (page: Page) => page.evaluate(() => (window as unknown as { __watch: Watch }).__watch);

async function expectStill(page: Page, moment: string): Promise<void> {
	const w = await watchOf(page);
	expect.soft(w.shifts, `layout shift inside main ${moment}`).toEqual([]);
	expect.soft(w.firstFrame, `the content under the card was never drawn ${moment}`).not.toBeNull();
	expect
		.soft(Math.abs((w.firstFrame ?? Infinity) - w.before), `px the content under the card jumped ${moment}`)
		.toBeLessThan(2);
}

for (const width of [390, 320]) {
	for (const under of ['empty', 'row'] as const) {
		test(`${width}px, ${under} under the card: /queue holds still as the first song starts and as it leaves`, async ({
			world
		}) => {
			const worker = await startFakeWorker(world);
			const maya = await world.openPhone('Maya');
			const theo = await world.openPhone('Theo');
			await theo.setViewportSize({ width, height: 844 });
			try {
				await readySong(world, maya, 'caroline');
			} finally {
				// No worker from here, so a song Theo asks for stays cooking (p19's fixture).
				await worker.stop();
			}
			if (under === 'row') {
				await openBrowseFromHome(theo);
				await theo.locator(SEL.search).fill('believin');
				await theo.locator(SEL.sing).first().click();
			}
			await openQueue(theo);
			if (under === 'row') await expect(theo.locator(SEL.processing)).toHaveCount(1);
			else await expect(theo.getByText('Nothing queued yet')).toBeVisible();
			await theo.evaluate(() => document.fonts.ready.then(() => true));

			// MOMENT 1: the room's first song starts. The room is idle, so Maya's turn plays at once.
			await watchPage(theo);
			await queueReady(maya, 'caroline');
			await expect(theo.locator(SEL.queueNowCard)).toContainText(/caroline/i, { timeout: 10_000 });
			// Past the --motion-base ease and a few frames more.
			await theo.waitForTimeout(1_000);
			await expectStill(theo, 'as the first song started');
			// The card itself fades in on the same token; the CLS half would pass without it, so it is asserted.
			expect.soft((await watchOf(theo)).cardAnimation, 'the card did not fade in').toMatch(/arrive/);
			// Never drawn over the content passing through its box: invisible until the content has cleared it.
			expect.soft((await watchOf(theo)).covered, 'opacity x px the card covered the content').toBeLessThan(2);
			// The fade's own end clears the flag, so the card does not carry `.arrive` for the rest of the song.
			await expect.soft(theo.locator(SEL.queueNowCard), 'still .arrive after the fade').not.toHaveClass(/arrive/);

			// MOMENT 2: skipped, with nothing playable behind it, so the card leaves.
			await watchPage(theo);
			await transportTap(maya, 'skip');
			await expect(theo.locator(SEL.queueNowCard)).toHaveCount(0, { timeout: 10_000 });
			await theo.waitForTimeout(1_000);
			await expectStill(theo, 'as the card left');
			if (under === 'row') await expect(theo.locator(SEL.processing)).toHaveCount(1);
			else await expect(theo.getByText('Nothing queued yet')).toBeVisible();

			// MOMENT 3, reduced motion: no fade runs, so no `animationend` would ever clear the flag. It is never set.
			await theo.emulateMedia({ reducedMotion: 'reduce' });
			await queueReady(maya, 'caroline');
			await expect(theo.locator(SEL.queueNowCard)).toContainText(/caroline/i, { timeout: 10_000 });
			await expect.soft(theo.locator(SEL.queueNowCard), '.arrive under reduced motion').not.toHaveClass(/arrive/);
		});
	}
}

// A CARD THE PAGE WAS TOLD ABOUT LATE CAME WITH THE PAGE. Both `hello` bursts send `queue:sync` and then
// `playback:state`, and the page renders in between. On a reload the card turns up in the second frame; on a
// reconnect after the song changed while the phone was away, the old song is gone from the queue in the first frame
// and the new one names the card in the second. Neither is a song starting, so neither eases nor fades: on main both
// are a plain swap.
test('390px: a reload during a song, and a reconnect after the song changed, are a cut', async ({ world }) => {
	const worker = await startFakeWorker(world);
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	await theo.setViewportSize({ width: 390, height: 844 });
	try {
		await readySong(world, maya, 'caroline');
		await readySong(world, maya, 'believin');
	} finally {
		await worker.stop();
	}
	// Every frame from page load: did the card ever carry `.arrive`, did the content under it ever ease?
	await theo.addInitScript(() => {
		const w = window as unknown as { __moved: { arrive: boolean; settle: boolean } };
		w.__moved = { arrive: false, settle: false };
		new MutationObserver(() => {
			if (document.querySelector('main > .below > .now.arrive')) w.__moved.arrive = true;
			if (document.querySelector('main [data-settle]')) w.__moved.settle = true;
		}).observe(document, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['class', 'data-settle']
		});
	});
	const moved = () => theo.evaluate(() => (window as unknown as { __moved: object }).__moved);
	await openQueue(theo);
	await queueReady(maya, 'caroline');
	await queueReady(maya, 'believin');
	await expect(theo.locator(SEL.queueNowCard)).toContainText(/caroline/i, { timeout: 10_000 });

	await theo.reload();
	await expect(theo.locator(SEL.queueNowCard)).toContainText(/caroline/i, { timeout: 10_000 });
	await theo.waitForTimeout(1_000);
	expect.soft(await moved(), 'the card moved on a reload').toEqual({ arrive: false, settle: false });

	await theo.evaluate(
		() => void ((window as unknown as { __moved: object }).__moved = { arrive: false, settle: false })
	);
	await goOffline(theo);
	await expect(theo.locator(SEL.npStripOffline)).toContainText('Reconnecting…', { timeout: 15_000 });
	await transportTap(maya, 'skip');
	await expect(maya.locator(SEL.npStripTitle)).toContainText(/believin/i, { timeout: 10_000 });
	await theo.context().setOffline(false);
	await expect(theo.locator(SEL.queueNowCard)).toContainText(/believin/i, { timeout: 15_000 });
	await theo.waitForTimeout(1_000);
	expect.soft(await moved(), 'the card moved on a reconnect').toEqual({ arrive: false, settle: false });
});
