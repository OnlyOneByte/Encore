// Proposal 33 PR 3a: Make it again -> Sound. The song never leaves the ready list while it is remade, the new stems
// arrive under new names, the old files go, and a TV that stayed open plays the new file with no reload.
import { test, expect } from '../../world/fixtures';
import { readySong, queueReady } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { Page } from '@playwright/test';
import type { Media } from '$lib/contract';

async function libraryRow(page: Page, id: string): Promise<Media | undefined> {
	const body = (await page.request.get('/api/library').then((r) => r.json())) as { library: Media[] };
	return body.library.find((m) => m.id === id);
}

const tvSources = (tv: Page) =>
	tv.evaluate(() =>
		[...document.querySelectorAll('audio, video')].map(
			(el) => (el as HTMLMediaElement).currentSrc || (el as HTMLMediaElement).src
		)
	);

test('Make again keeps the song ready throughout, swaps in new files, and the open TV plays them', async ({
	world
}, testInfo) => {
	// Slow enough that the remake spans many 100 ms samples.
	const worker = await startFakeWorker(world, { slowMs: 600 });
	try {
		const guest = await world.openPhone('Ana');
		await readySong(world, guest, 'caroline');
		const id = (await world.awaitDemoTrack('caroline')).id;
		const before = (await libraryRow(guest, id))!.instrumentalRef!;
		const tv = await world.openTv();

		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await host.goto('/library');
		await host.getByRole('button', { name: 'Manage' }).click();
		await host.locator('[data-testid="manage-row"] button.open').first().click();
		await host.locator('[data-testid="song-sheet"]').getByRole('button', { name: 'Make again' }).click();
		await expect(host.getByText('Making the sound again', { exact: false })).toBeVisible();
		for (const width of [390, 320]) {
			await host.setViewportSize({ width, height: 844 });
			const path = testInfo.outputPath(`remake-toast-${width}.png`);
			await host.screenshot({ path });
			await testInfo.attach(`remake-toast-${width}.png`, { path, contentType: 'image/png' });
		}

		// THE CLAIM: listReady holds the song at every 100 ms sample until the new stems are in.
		const samples: { present: boolean; ref?: string }[] = [];
		const deadline = Date.now() + 60_000;
		let after = before;
		while (Date.now() < deadline) {
			const row = await libraryRow(guest, id);
			samples.push({ present: !!row, ref: row?.instrumentalRef });
			if (row?.instrumentalRef && row.instrumentalRef !== before) {
				after = row.instrumentalRef;
				break;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(after, 'the remake never swapped in').not.toBe(before);
		expect(samples.length, 'the remake landed before a single sample: nothing was measured').toBeGreaterThan(5);
		expect(
			samples.filter((s) => !s.present),
			'the song left the ready list mid-remake'
		).toEqual([]);
		expect(after).toMatch(new RegExp(`derived/stems/${id}-[0-9a-z]+-instrumental\\.`));

		// New files are served, the replaced one is gone.
		expect((await guest.request.get(`/media/${after}`)).status()).toBe(200);
		await expect.poll(async () => (await guest.request.get(`/media/${before}`)).status()).toBe(404);

		// The phone and the TV were never reloaded: the phone queues it from the page it had open, and the TV plays
		// the NEW file.
		await queueReady(guest, 'caroline');
		await expect
			.poll(async () => (await tvSources(tv)).some((src) => src.includes(after)), {
				timeout: 30_000,
				message: `the open TV never played ${after}`
			})
			.toBe(true);
		expect((await tvSources(tv)).some((src) => src.includes(before))).toBe(false);
	} finally {
		await worker.stop();
	}
});

test('a song queued tonight is remade after its turn, not under it', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const guest = await world.openPhone('Ana');
		await readySong(world, guest, 'caroline');
		const id = (await world.awaitDemoTrack('caroline')).id;
		const before = (await libraryRow(guest, id))!.instrumentalRef!;
		await queueReady(guest, 'caroline');

		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		const res = await host.request.post('/api/library/manage/remake', { data: { mediaId: id } });
		expect(res.ok()).toBe(true);
		expect((await res.json()).afterTurn).toBe(true);
		// Held: a few dispatch ticks (3 s each) pass with the stems untouched.
		await new Promise((r) => setTimeout(r, 7_000));
		expect((await libraryRow(guest, id))!.instrumentalRef).toBe(before);
	} finally {
		await worker.stop();
	}
});
