// THE DOCK NEVER MOVES. Theo is the phone watched, on /queue, and every transition comes from another
// phone, so nothing Theo sees is exempt as recent input. A dock with three heights — tabs alone (48),
// strip + tabs (93) and the reaction row on top (164) — moves its top edge 45 to 116 px across four of these
// transitions on every phone in the room (CLS 0.0163 to 0.2433 at 320). It is strip + tabs in every state, so
// across each one there must be NO layout-shift entry sourced from the dock or anything in it, and the dock's box
// must be identical. The page's own shifts (the /queue list as the Now card comes and goes) are not this claim.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openQueue, queueReady, readySong } from '../../world/actors';
import type { Page } from '@playwright/test';

type Shift = { value: number; hadRecentInput: boolean; inDock: string[] };

async function watch(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { __shifts: Shift[]; __obs?: PerformanceObserver };
		w.__obs?.disconnect();
		w.__shifts = [];
		w.__obs = new PerformanceObserver((list) => {
			const dock = document.querySelector('.dock');
			for (const e of list.getEntries() as unknown as {
				value: number;
				hadRecentInput: boolean;
				sources: { node?: Node | null }[];
			}[]) {
				const inDock = e.sources
					.filter((s) => !!s.node && !!dock?.contains(s.node))
					.map((s) => (s.node as Element).className?.toString() ?? '?');
				w.__shifts.push({ value: e.value, hadRecentInput: e.hadRecentInput, inDock });
			}
		});
		w.__obs.observe({ type: 'layout-shift', buffered: false });
	});
}

const dockShifts = (page: Page) =>
	page.evaluate(() => (window as unknown as { __shifts: Shift[] }).__shifts.filter((s) => s.inDock.length > 0));

for (const [width, height] of [
	[390, 844],
	[320, 568]
] as const) {
	test(`${width}x${height}: the dock holds still across all seven transitions`, async ({ world }) => {
		test.setTimeout(4 * 60_000);
		const worker = await startFakeWorker(world);
		try {
			const maya = await world.openPhone('Maya');
			const theo = await world.openPhone('Theo');
			const ana = await world.openPhone('Ana');
			await theo.setViewportSize({ width, height });
			await readySong(world, maya, 'caroline');
			await readySong(world, maya, 'believin');
			await readySong(world, maya, 'prayer');
			await world.openTv();
			await openQueue(theo);
			await expect(theo.locator(SEL.npStripIdle)).toHaveText('Nothing playing');
			// No song, no progress: the hairline is empty, not drawn full by an invalid `scaleX(null)`.
			await expect(theo.locator('.dock .strip .fill')).toHaveCSS('transform', 'matrix(0, 0, 0, 1, 0, 0)');
			await theo.waitForTimeout(1_000);
			const dock = theo.locator(SEL.dock);
			const box = await dock.boundingBox();
			const skip = (p: Page) => p.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
			const reactions = (on: boolean) => ana.request.put('/api/settings/room', { data: { tvReactions: on } });

			const across = async (name: string, act: () => Promise<unknown>, settled: () => Promise<unknown>) => {
				await watch(theo);
				await act();
				await settled();
				// Past the Cheer key's --motion-base fade and a few frames more.
				await theo.waitForTimeout(1_000);
				expect.soft(await dockShifts(theo), `${name}: layout-shift entries sourced from the dock`).toEqual([]);
				expect.soft(await dock.boundingBox(), `${name}: the dock moved or resized`).toEqual(box);
			};

			await across(
				'1 someone starts the first song',
				() => queueReady(maya, 'caroline'),
				() => expect(theo.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 30_000 })
			);
			await expect(theo.locator(SEL.npCheerKey)).not.toHaveAttribute('inert');

			// Theo's own turn, queued between the measured transitions: his taps are input, so they are not measured.
			await theo.goto('/');
			await queueReady(theo, 'believin');
			await openQueue(theo);
			await queueReady(ana, 'prayer');
			await theo.waitForTimeout(1_500);

			await across(
				'2 the host turns reactions off',
				() => reactions(false),
				() => expect(theo.locator(SEL.npCheerKey)).toHaveAttribute('inert')
			);
			await across(
				'3 and back on',
				() => reactions(true),
				() => expect(theo.locator(SEL.npCheerKey)).not.toHaveAttribute('inert')
			);
			await across(
				'4 your song starts',
				() => skip(ana),
				() => expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i, { timeout: 5_000 })
			);
			// The singer's own key rests in place: nothing to find or tap, and the server refuses it anyway.
			await expect(theo.locator(SEL.npCheerKey)).toHaveAttribute('inert');
			await expect(theo.locator(SEL.npCheerKey)).toHaveCSS('visibility', 'hidden');
			await theo.waitForTimeout(3_000);

			await across(
				'5 song to song',
				() => skip(maya),
				() => expect(theo.locator(SEL.npStripTitle)).toContainText(/prayer/i, { timeout: 5_000 })
			);
			await across(
				'6 the last song ends',
				() => skip(maya),
				() => expect(theo.locator(SEL.npStripIdle)).toHaveText('Nothing playing', { timeout: 5_000 })
			);
			await expect(theo.locator(SEL.npTransport), 'an idle room shows no transport').toHaveCount(0);
			await across(
				'7 the link drops',
				() => theo.context().setOffline(true),
				() => expect(theo.locator(SEL.npStripOffline)).toContainText('Reconnecting…', { timeout: 15_000 })
			);
			await theo.context().setOffline(false);
		} finally {
			await worker.stop();
		}
	});
}
