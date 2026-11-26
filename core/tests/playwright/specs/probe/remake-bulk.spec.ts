// Proposal 33 PR 2's bulk remake: the sound or the lyrics made again for several picked songs at once. Every song stays
// in the ready list while it is remade, each swaps to its own new files, the old ones go, and an open TV follows.
import { test, expect } from '../../world/fixtures';
import { readySong, queueReady } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import { SEL } from '../../world/selectors';
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

/** Where each part of the bar sits, for the fit checks below (the #1348 review's measurements). */
async function barLayout(bar: import('@playwright/test').Locator) {
	return bar.evaluate((b) => {
		const box = (el: Element) => {
			const q = el.getBoundingClientRect();
			return { l: q.left, r: q.right, t: q.top, b: q.bottom, w: q.width, h: q.height };
		};
		return {
			bar: box(b),
			scroll: b.scrollWidth > b.clientWidth,
			n: box(b.querySelector('.n')!),
			buttons: [...b.querySelectorAll('button')].map((x) => ({ name: x.textContent?.trim(), ...box(x) })),
			vw: innerWidth
		};
	});
}

test('the bulk bar fits at 320 and 390 with Keep off and a four-digit count, every action a full tap target', async ({
	world
}, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const guest = await world.openPhone('Ana');
		for (const track of TRACKS) await readySong(world, guest, track);
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await host.goto('/library');
		await host.getByRole('button', { name: 'Manage' }).click();
		await host.getByTestId('pick-all').click();
		const bar = host.locator('[data-testid="bulk-bar"]');
		const rows = host.locator('[data-testid="manage-row"]');
		for (const keepOff of [false, true]) {
			if (keepOff) {
				await bar.getByRole('button', { name: 'Keep', exact: true }).click();
				await expect(bar.getByRole('button', { name: 'Keep off' })).toBeVisible();
			}
			for (const count of ['3', '1234']) {
				// The widest count a big Select all shows, written into the same span.
				await bar.locator('.n').evaluate((el, c) => (el.textContent = `${c} picked`), count);
				for (const width of [320, 390]) {
					await host.setViewportSize({ width, height: 844 });
					const out = await barLayout(bar);
					const at = `${width}px, ${count} picked${keepOff ? ', Keep off' : ''}`;
					expect(out.scroll, `the bar overflows at ${at}`).toBe(false);
					expect(out.bar.r, `the bar leaves the screen at ${at}`).toBeLessThanOrEqual(out.vw);
					for (const b of out.buttons) {
						expect(b.w, `${b.name} width at ${at}`).toBeGreaterThanOrEqual(44);
						expect(b.h, `${b.name} height at ${at}`).toBeGreaterThanOrEqual(44);
						expect(b.r, `${b.name} past the bar at ${at}`).toBeLessThanOrEqual(out.bar.r + 0.5);
						// Beside the count or on the row below it, never over it.
						expect(b.l >= out.n.r - 0.5 || b.t >= out.n.b - 0.5, `${b.name} over the count at ${at}`).toBe(true);
					}
					// The last row still scrolls clear of the bar, however many rows the bar has.
					await host.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
					const last = await rows.last().boundingBox();
					expect(last && last.y + last.height, `the last row is under the bar at ${at}`).toBeLessThanOrEqual(
						out.bar.t + 0.5
					);
					if (keepOff && count === '1234') {
						const path = testInfo.outputPath(`bulk-bar-widest-${width}.png`);
						await host.mouse.move(0, 0); // no hover fill left from the Keep tap
						await host.screenshot({ path });
						await testInfo.attach(`bulk-bar-widest-${width}.png`, { path, contentType: 'image/png' });
					}
				}
			}
		}
	} finally {
		await worker.stop();
	}
});

test('bulk Make again with a song in tonight’s queue: it waits for its turn, and the toast says so', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const guest = await world.openPhone('Ana');
		for (const track of TRACKS) await readySong(world, guest, track);
		const queuedId = (await world.awaitDemoTrack(TRACKS[0]!)).id;
		const before = (await library(guest)).find((m) => m.id === queuedId)!.instrumentalRef;
		await queueReady(guest, TRACKS[0]!);
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await host.goto('/library');
		await host.getByRole('button', { name: 'Manage' }).click();
		await host.getByTestId('pick-all').click();
		await host.locator('[data-testid="bulk-bar"]').getByRole('button', { name: 'Sound again' }).click();
		await expect(host.getByText('Making the sound again for 3 songs')).toBeVisible();
		await expect(host.getByText("1 song in tonight's queue: after its turn.")).toBeVisible();
		// The other two are remade; the queued one keeps its stems across dispatch ticks.
		await expect
			.poll(
				async () =>
					(await library(guest)).filter(
						(m) => m.id !== queuedId && /-[0-9a-z]+-instrumental\./.test(m.instrumentalRef ?? '')
					).length,
				{ timeout: 60_000 }
			)
			.toBe(2);
		expect((await library(guest)).find((m) => m.id === queuedId)!.instrumentalRef).toBe(before);
	} finally {
		await worker.stop();
	}
});

test('bulk Lyrics again: three songs stay ready, one playing on the TV swaps its lyrics with no gap, old documents go', async ({
	world
}, testInfo) => {
	test.setTimeout(180_000);
	// A 40 s song, so the playing one is still on the TV when its remake lands.
	const worker = await startFakeWorker(world, { seconds: 40, slowMs: 600 });
	try {
		const guest = await world.openPhone('Ana');
		for (const track of TRACKS) await readySong(world, guest, track);
		const ids = await Promise.all(TRACKS.map(async (t) => (await world.awaitDemoTrack(t)).id));
		const before = new Map((await library(guest)).map((m) => [m.id, m.lyricsRef!]));
		expect([...before.values()].every(Boolean), 'a song had no lyrics to remake').toBe(true);

		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await host.goto('/library');
		await host.getByRole('button', { name: 'Manage' }).click();
		await host.getByTestId('pick-all').click();
		const bar = host.locator('[data-testid="bulk-bar"]');
		await expect(bar).toContainText('3 picked');
		await frame(host, testInfo, 'bulk-lyrics-bar');

		// The first song plays on an open TV, its lyrics on screen, right before the tap.
		await queueReady(guest, TRACKS[0]!);
		const tv = await world.openTv();
		await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
		await tv.mouse.click(960, 540);
		await tv.locator(SEL.lyricsRowCurrent).waitFor({ timeout: 30_000 });
		await tv.evaluate((row) => {
			const w = window as unknown as { rowCounts: number[] };
			w.rowCounts = [];
			setInterval(() => w.rowCounts.push(document.querySelectorAll(row).length), 25);
		}, SEL.lyricsRow);

		await bar.getByRole('button', { name: 'Lyrics again' }).click();
		await expect(host.getByText('Making the lyrics again for 3 songs')).toBeVisible();
		// Not "after its turn": a lyrics remake is never held for the turn.
		await expect(host.getByText("1 song in tonight's queue: the new lyrics swap in between lines.")).toBeVisible();
		await host
			.locator('[data-sonner-toast]')
			.first()
			.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
		await frame(host, testInfo, 'bulk-lyrics-toast');

		// THE CLAIM: every picked song is in the ready list at every 100 ms sample until all three have new lyrics.
		const missing: string[] = [];
		let samples = 0;
		const after = new Map<string, string>();
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline && after.size < ids.length) {
			const rows = new Map((await library(guest)).map((m) => [m.id, m]));
			samples++;
			for (const id of ids) {
				const ref = rows.get(id)?.lyricsRef;
				if (!rows.has(id)) missing.push(id);
				else if (ref && ref !== before.get(id)) after.set(id, ref);
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(after.size, 'not every picked song got new lyrics').toBe(ids.length);
		expect(samples, 'the remakes landed before they were sampled').toBeGreaterThan(5);
		expect(missing, 'a song left the ready list mid-remake').toEqual([]);

		// The playing song's new words reach the TV, never reloaded, with no sample of an empty lyrics screen.
		await expect(tv.locator(SEL.lyricsRow, { hasText: 'Remade' }).first()).toBeAttached({ timeout: 20_000 });
		// The frame below: the remade words on screen, if the song has not already sung past them.
		await tv
			.locator(SEL.lyricsRow, { hasText: 'Remade' })
			.first()
			.waitFor({ state: 'visible', timeout: 5_000 })
			.catch(() => {});
		const counts = await tv.evaluate(() => (window as unknown as { rowCounts: number[] }).rowCounts);
		expect(counts.length, 'nothing was sampled').toBeGreaterThan(40);
		expect(counts.filter((n) => n === 0).length, 'a sample with no lyrics on the TV').toBe(0);
		const path = testInfo.outputPath('bulk-lyrics-tv.png');
		await tv.screenshot({ path });
		await testInfo.attach('bulk-lyrics-tv.png', { path, contentType: 'image/png' });

		for (const id of ids) {
			const ref = after.get(id)!;
			expect(ref).toMatch(new RegExp(`derived/lyrics/${id}-[0-9a-z]+(-.+)?\\.json$`));
			const doc = await guest.request.get(`/media/${ref}`);
			expect(doc.status()).toBe(200);
			expect((await doc.text()).length, `${ref} is empty`).toBeGreaterThan(2);
			await expect.poll(async () => (await guest.request.get(`/media/${before.get(id)}`)).status()).toBe(404);
		}
	} finally {
		await worker.stop();
	}
});

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
		await expect(bar.getByRole('button', { name: 'Sound again' })).toBeVisible();
		await frame(host, testInfo, 'bulk-remake-bar');
		await bar.getByRole('button', { name: 'Sound again' }).click();
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
