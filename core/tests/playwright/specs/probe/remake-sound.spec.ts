// Proposal 33 PR 3a: Make it again -> Sound. The song never leaves the ready list while it is remade, the new stems
// arrive under new names, the old files go, and a TV that stayed open plays the new file with no reload.
import { test, expect } from '../../world/fixtures';
import { readySong, queueReady } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { Page } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
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

test('Sound again keeps the song ready throughout, swaps in new files, and the open TV plays them', async ({
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
		await host.locator('[data-testid="song-sheet"]').getByRole('button', { name: 'Sound again' }).click();

		// THE CLAIM: listReady holds the song at every 100 ms sample until the new stems are in. Sampled FROM THE TAP,
		// alongside the toast's screenshots: sampled after them, the runner's two screenshots outlasted the remake and
		// it landed at the second sample (#1134).
		const samples: { present: boolean; ref?: string }[] = [];
		const sampling = (async () => {
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				const row = await libraryRow(guest, id);
				samples.push({ present: !!row, ref: row?.instrumentalRef });
				if (row?.instrumentalRef && row.instrumentalRef !== before) return row.instrumentalRef;
				await new Promise((r) => setTimeout(r, 100));
			}
			return before;
		})();
		await expect(host.getByText('Making the sound again', { exact: false })).toBeVisible();
		for (const width of [390, 320]) {
			await host.setViewportSize({ width, height: 844 });
			const path = testInfo.outputPath(`remake-toast-${width}.png`);
			await host.screenshot({ path });
			await testInfo.attach(`remake-toast-${width}.png`, { path, contentType: 'image/png' });
		}
		const after = await sampling;
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

test('queued and playing mid-remake: the TV plays the old file to the end, then the new one is in and the old goes', async ({
	world
}) => {
	const maker = await startFakeWorker(world, { seconds: 20 });
	const guest = await world.openPhone('Ana');
	await readySong(world, guest, 'caroline');
	await maker.stop();
	const id = (await world.awaitDemoTrack('caroline')).id;
	const before = (await libraryRow(guest, id))!.instrumentalRef!;
	const tv = await world.openTv();
	// Slow enough that the song is queued, and then playing, before the remake finishes.
	const worker = await startFakeWorker(world, { slowMs: 6_000, seconds: 20 });
	try {
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		const res = await host.request.post('/api/library/manage/remake', { data: { mediaId: id } });
		expect((await res.json()).afterTurn).toBe(false); // idle: dispatched now
		await queueReady(guest, 'caroline');
		await expect.poll(async () => (await tvSources(tv)).some((src) => src.includes(before))).toBe(true);

		// THE CLAIM: while the turn lasts, the song names the old file, the file is there, and the TV keeps playing it.
		let after = before;
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const ref = (await libraryRow(guest, id))?.instrumentalRef;
			const playingOld = (await tvSources(tv)).some((src) => src.includes(before));
			if (ref && ref !== before) {
				after = ref;
				break;
			}
			if (playingOld) expect((await guest.request.get(`/media/${before}`)).status()).toBe(200);
			await new Promise((r) => setTimeout(r, 250));
		}
		expect(after, 'the remake never swapped in after the turn').not.toBe(before);
		expect((await guest.request.get(`/media/${after}`)).status()).toBe(200);
		await expect.poll(async () => (await guest.request.get(`/media/${before}`)).status()).toBe(404);
	} finally {
		await worker.stop();
	}
});

test.describe('across a restart', () => {
	// A file-backed DB, so the restart keeps the library, the jobs and the held completion.
	test.use({ coreEnv: { ENCORE_EPHEMERAL: '0' } });
	test('a remake held for the turn survives a core restart, and the new sound goes in after (#1317)', async ({
		world
	}) => {
		test.setTimeout(240_000);
		const maker = await startFakeWorker(world, { seconds: 20 });
		const guest = await world.openPhone('Ana');
		await readySong(world, guest, 'caroline');
		await maker.stop();
		const id = (await world.awaitDemoTrack('caroline')).id;
		const before = (await libraryRow(guest, id))!.instrumentalRef!;
		const tv = await world.openTv();
		const worker = await startFakeWorker(world, { slowMs: 6_000, seconds: 20 });
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		const res = await host.request.post('/api/library/manage/remake', { data: { mediaId: id } });
		expect((await res.json()).afterTurn).toBe(false);
		await queueReady(guest, 'caroline');
		await expect.poll(async () => (await tvSources(tv)).some((src) => src.includes(before))).toBe(true);

		// The remake finishes mid-song: its completion is held (a `held_completions` row), the song still naming the old.
		const heldRows = () => {
			const db = new DatabaseSync(join(world.core.dataDir, 'encore.sqlite'));
			try {
				return (db.prepare('SELECT COUNT(*) AS n FROM held_completions WHERE media_id = ?').get(id) as { n: number }).n;
			} finally {
				db.close();
			}
		};
		await expect
			.poll(heldRows, { timeout: 60_000, message: 'the remake never finished while its song played' })
			.toBe(1);
		expect((await libraryRow(guest, id))?.instrumentalRef).toBe(before);
		const stems = join(world.mediaDir, 'derived/stems');
		const tagged = () => readdirSync(stems).filter((n) => new RegExp(`^${id}-[0-9a-z]+-instrumental\\.`).test(n));
		expect(tagged()).toHaveLength(1);

		// No worker is left to make it again, so only the held completion itself can bring the new sound in.
		await worker.stop();
		await world.core.restart();

		await expect
			.poll(async () => (await libraryRow(guest, id))?.instrumentalRef, {
				timeout: 90_000,
				message: 'the held remake was lost to the restart'
			})
			.toBe(`derived/stems/${tagged()[0]}`);
		// Its files survived the boot sweep, and the replaced file goes once the turn is over.
		const after = (await libraryRow(guest, id))!.instrumentalRef!;
		expect((await guest.request.get(`/media/${after}`)).status()).toBe(200);
		await expect
			.poll(async () => (await guest.request.get(`/media/${before}`)).status(), { timeout: 30_000 })
			.toBe(404);
	});
});

test('a remake that fails says so on the song sheet, and the old sound stays', async ({ world }, testInfo) => {
	const maker = await startFakeWorker(world);
	const guest = await world.openPhone('Ana');
	await readySong(world, guest, 'caroline');
	await maker.stop();
	const id = (await world.awaitDemoTrack('caroline')).id;
	const before = (await libraryRow(guest, id))!.instrumentalRef!;
	const worker = await startFakeWorker(world, { fail: 'stems-remake' });
	try {
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await host.goto('/library');
		await host.getByRole('button', { name: 'Manage' }).click();
		await host.locator('[data-testid="manage-row"] button.open').first().click();
		await host.getByRole('button', { name: 'Sound again' }).click();
		await expect
			.poll(
				async () => {
					await host.reload();
					await host.getByRole('button', { name: 'Manage' }).click();
					await host.locator('[data-testid="manage-row"] button.open').first().click();
					return host.getByTestId('remake-failed').isVisible();
				},
				{ timeout: 30_000, message: 'the sheet never said the remake failed' }
			)
			.toBe(true);
		await expect(host.getByTestId('remake-failed')).toContainText("didn't work");
		for (const width of [390, 320]) {
			await host.setViewportSize({ width, height: 844 });
			const path = testInfo.outputPath(`remake-failed-${width}.png`);
			await host.locator('[data-testid="song-sheet"]').screenshot({ path });
			await testInfo.attach(`remake-failed-${width}.png`, { path, contentType: 'image/png' });
		}
		expect((await libraryRow(guest, id))!.instrumentalRef).toBe(before);
		expect((await guest.request.get(`/media/${before}`)).status()).toBe(200);
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
