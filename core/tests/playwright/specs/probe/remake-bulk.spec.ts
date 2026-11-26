// Proposal 33 PR 2's bulk remake: Make again for several picked songs at once. Every song stays in the ready list
// while it is remade, each swaps to its own new files, the old ones go, and an open TV plays the new sound.
import { test, expect } from '../../world/fixtures';
import { readySong, queueReady } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { Page, TestInfo } from '@playwright/test';
import type { Media } from '$lib/contract';

const TRACKS = ['caroline', 'bohemian', 'prayer'];

async function library(page: Page): Promise<Media[]> {
	return ((await page.request.get('/api/library').then((r) => r.json())) as { library: Media[] }).library;
}

async function frame(page: Page, testInfo: TestInfo, name: string, widths = [390, 320]): Promise<void> {
	for (const width of widths) {
		await page.setViewportSize({ width, height: 844 });
		const path = testInfo.outputPath(`${name}-${width}.png`);
		await page.screenshot({ path });
		await testInfo.attach(`${name}-${width}.png`, { path, contentType: 'image/png' });
	}
	await page.setViewportSize({ width: 390, height: 844 });
}

test('bulk Make again: three picked songs stay ready, each gets new files, and the open TV plays one', async ({
	world
}, testInfo) => {
	// Slow enough that the three remakes span many 100 ms samples.
	const worker = await startFakeWorker(world, { slowMs: 600 });
	try {
		const guest = await world.openPhone('Ana');
		for (const track of TRACKS) await readySong(world, guest, track);
		const ids = await Promise.all(TRACKS.map(async (t) => (await world.awaitDemoTrack(t)).id));
		const before = new Map((await library(guest)).map((m) => [m.id, m.instrumentalRef!]));
		const tv = await world.openTv();

		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await host.goto('/library');
		await host.getByRole('button', { name: 'Manage' }).click();
		await host.getByTestId('pick-all').click();
		const bar = host.locator('[data-testid="bulk-bar"]');
		await expect(bar).toContainText('3 picked');
		await expect(bar.getByRole('button', { name: 'Make again' })).toBeVisible();
		await frame(host, testInfo, 'bulk-remake-bar');
		await bar.getByRole('button', { name: 'Make again' }).click();
		await expect(host.getByText('Making the sound again for 3 songs')).toBeVisible();
		await expect(bar).toHaveCount(0); // out of the toast's way
		await host
			.locator('[data-sonner-toast]')
			.first()
			.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
		await frame(host, testInfo, 'bulk-remake-toast');

		// THE CLAIM: every picked song is in the ready list at every 100 ms sample until all three have swapped.
		const missing: string[] = [];
		let samples = 0;
		const after = new Map<string, string>();
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline && after.size < ids.length) {
			const rows = new Map((await library(guest)).map((m) => [m.id, m]));
			samples++;
			for (const id of ids) {
				const ref = rows.get(id)?.instrumentalRef;
				if (!ref) missing.push(id);
				else if (ref !== before.get(id)) after.set(id, ref);
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(after.size, 'not every picked song was remade').toBe(ids.length);
		expect(samples, 'the remakes landed before they were sampled').toBeGreaterThan(5);
		expect(missing, 'a song left the ready list mid-remake').toEqual([]);

		for (const id of ids) {
			const ref = after.get(id)!;
			expect(ref).toMatch(new RegExp(`derived/stems/${id}-[0-9a-z]+-instrumental\\.`));
			expect((await guest.request.get(`/media/${ref}`)).status()).toBe(200);
			await expect.poll(async () => (await guest.request.get(`/media/${before.get(id)}`)).status()).toBe(404);
		}
		// Each its own job, so each its own tag.
		expect(new Set([...after.values()].map((r) => r.split('-')[1])).size).toBe(ids.length);

		// The TV, open all along, plays the new sound of a remade song.
		await queueReady(guest, TRACKS[0]!);
		const remade = after.get(ids[0]!)!;
		await expect
			.poll(
				async () =>
					tv.evaluate(
						(ref) =>
							[...document.querySelectorAll('audio, video')].some((el) =>
								((el as HTMLMediaElement).currentSrc || (el as HTMLMediaElement).src).includes(ref)
							),
						remade
					),
				{ timeout: 30_000, message: `the open TV never played ${remade}` }
			)
			.toBe(true);
		// Past the Now singing card, onto the song itself.
		await expect(tv.getByText('Now singing')).toBeHidden({ timeout: 20_000 });
		const path = testInfo.outputPath('bulk-remake-tv.png');
		await tv.screenshot({ path });
		await testInfo.attach('bulk-remake-tv.png', { path, contentType: 'image/png' });
	} finally {
		await worker.stop();
	}
});
