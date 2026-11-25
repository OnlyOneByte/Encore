// Proposal 33 PR 1: the host's Manage on the Library tab, and a guest's Library with none of it.
// See docs/FRONTEND.md#the-library-page and docs/SERVER.md#managing-the-library.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../world/fixtures';
import { queueReady, readySong, transportTap } from '../../world/actors';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import type { Page, TestInfo } from '@playwright/test';
import type { Media } from '$lib/contract';

async function frame(page: Page, testInfo: TestInfo, name: string): Promise<void> {
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		const path = testInfo.outputPath(`${name}-${width}.png`);
		await page.screenshot({ path });
		await testInfo.attach(`${name}-${width}.png`, { path, contentType: 'image/png' });
	}
	await page.setViewportSize({ width: 390, height: 844 });
}

async function libraryIds(page: Page): Promise<string[]> {
	const body = (await page.request.get('/api/library').then((r) => r.json())) as { library: Media[] };
	return body.library.map((m) => m.id);
}

test('a guest sees no Manage; the host renames, keeps, deletes and undoes', async ({ world }, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const guest = await world.openPhone('Ana');
		await readySong(world, guest, 'caroline');
		const id = (await world.awaitDemoTrack('caroline')).id;

		// THE GUEST: the Library tab exactly as before.
		await guest.goto('/library');
		await expect(guest.getByText('Caroline', { exact: false }).first()).toBeVisible();
		await expect(guest.getByRole('button', { name: 'Manage' })).toHaveCount(0);
		await expect(guest.locator('[data-testid="manage-row"], [data-testid="song-size"]')).toHaveCount(0);
		expect((await guest.request.get('/api/library/sizes')).status()).toBe(403);
		await frame(guest, testInfo, 'guest');

		// THE HOST.
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await host.goto('/library');
		await host.getByRole('button', { name: 'Manage' }).click();
		const row = host.locator('[data-testid="manage-row"]').first();
		await expect(row.locator('[data-testid="song-size"]')).toHaveText(/\d+ MB/);
		await expect(host.locator('.count').first()).toHaveText(/1 song · \d+ MB/);
		await frame(host, testInfo, 'manage');

		await row.locator('button.open').click();
		const sheet = host.locator('[data-testid="song-sheet"]');
		await expect(sheet).toContainText('sung 0 times');
		await frame(host, testInfo, 'song-sheet');

		// Rename: the guest's Library follows.
		await sheet.getByRole('button', { name: 'Change' }).click();
		await sheet.getByLabel('Title').fill('Renamed By Host');
		await sheet.getByLabel('Artist').fill('Neil Diamond');
		await sheet.getByRole('button', { name: 'Save' }).click();
		await expect(row).toContainText('Renamed By Host');
		await expect(row).toContainText('Neil Diamond');
		await expect(guest.getByText('Renamed By Host').first()).toBeVisible();

		// Keep: a kept song offers no Delete, and the server refuses one.
		await sheet.getByRole('switch').click();
		await expect(row).toContainText('Kept');
		await expect(sheet.getByRole('button', { name: 'Delete' })).toHaveCount(0);
		await expect(sheet).toContainText('Turn Keep off to delete');
		expect((await host.request.post('/api/library/manage/delete', { data: { mediaId: id } })).status()).toBe(409);
		await sheet.getByRole('switch').click();
		await expect(row).not.toContainText('Kept');

		// Delete, then Undo inside the window: the song is back and nothing was removed.
		await sheet.getByRole('button', { name: 'Delete' }).click();
		await expect(host.locator('[data-testid="manage-row"]')).toHaveCount(0);
		await expect(host.getByText('Your file stays in the library folder')).toBeVisible();
		await frame(host, testInfo, 'deleted-toast');
		await host.getByRole('button', { name: 'Undo' }).click();
		await expect(host.locator('[data-testid="manage-row"]')).toHaveCount(1);
		expect(await libraryIds(host)).toContain(id);

		// Delete and let the window close: the song's files go, the library-folder file stays.
		await host.locator('[data-testid="manage-row"] button.open').click();
		await host.getByRole('button', { name: 'Delete' }).click();
		// Polled: the click returns before the delete request has landed.
		await expect.poll(() => libraryIds(guest)).not.toContain(id);
		// During the window the song is offered nowhere: not on a guest's open Library, not in search.
		await expect(guest.getByText('Renamed By Host')).toHaveCount(0);
		const search = (await (await guest.request.get('/api/search?q=caroline')).json()) as Record<string, Media[]>;
		expect(
			Object.values(search)
				.flat()
				.some((m) => m?.id === id)
		).toBe(false);
		expect(existsSync(join(world.mediaDir, 'meta', `${id}.json`))).toBe(true);
		await expect.poll(() => existsSync(join(world.mediaDir, 'meta', `${id}.json`)), { timeout: 20_000 }).toBe(false);
		expect(readdirSync(join(world.mediaDir, 'library')).some((f) => f.includes('caroline'))).toBe(true);
		expect((await host.request.post('/api/library/manage/undo', { data: { mediaId: id } })).status()).toBe(409);
	} finally {
		await worker.stop();
	}
});

test('bulk: pick songs, Keep them, Select all and Delete with one Undo; a kept song stays', async ({
	world
}, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const guest = await world.openPhone('Cy');
		for (const track of ['caroline', 'bohemian', 'prayer', 'believin']) await readySong(world, guest, track);
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await host.goto('/library');
		await host.getByRole('button', { name: 'Manage' }).click();
		const rows = host.locator('[data-testid="manage-row"]');
		await expect(rows).toHaveCount(4);
		const bar = host.locator('[data-testid="bulk-bar"]');
		await expect(bar).toHaveCount(0);

		// Two picked: the bar names the count and sits clear of the dock.
		await rows.nth(0).getByRole('checkbox').click();
		await rows.nth(1).getByRole('checkbox').click();
		await expect(bar).toContainText('2 picked');
		const dockTop = await host
			.locator(SEL.dock)
			.first()
			.evaluate((d) => d.getBoundingClientRect().top);
		const barBox = await bar.boundingBox();
		expect(barBox && barBox.y + barBox.height).toBeLessThanOrEqual(dockTop);
		await frame(host, testInfo, 'two-picked');

		// Keep both, then the bar offers Keep off.
		await bar.getByRole('button', { name: 'Keep', exact: true }).click();
		await expect(rows.filter({ hasText: 'Kept' })).toHaveCount(2);
		await expect(bar.getByRole('button', { name: 'Keep off' })).toBeVisible();
		await bar.getByRole('button', { name: 'Keep off' }).click();
		await expect(rows.filter({ hasText: 'Kept' })).toHaveCount(0);

		// A filter change drops the picks, so Delete never reaches a song out of view.
		await expect(bar).toContainText('2 picked');
		const filter = host.getByLabel('Filter your library');
		await filter.fill('bohemian');
		await expect(rows).toHaveCount(1);
		await expect(bar).toHaveCount(0);
		await filter.fill('');
		await expect(rows).toHaveCount(4);
		await rows.nth(0).getByRole('checkbox').click();

		// Keep just one, then Select all and Delete: the kept one stays and the toast says so.
		await bar.getByRole('button', { name: 'Keep', exact: true }).click();
		await expect(rows.filter({ hasText: 'Kept' })).toHaveCount(1);
		await host.getByTestId('pick-all').click();
		await expect(bar).toContainText('4 picked');
		await bar.getByRole('button', { name: 'Delete' }).click();
		await expect(host.getByText('3 songs deleted')).toBeVisible();
		await expect(host.getByText('1 song stayed: kept, or in tonight')).toBeVisible();
		await expect(rows).toHaveCount(1);
		await expect(bar).toHaveCount(0); // out of the Undo toast's way
		// The focused button left with the bar; focus lands on a control that stays.
		await expect(host.getByTestId('pick-all')).toBeFocused();
		// The frame shows the settled toast, not its slide-in.
		await host
			.locator('[data-sonner-toast]')
			.first()
			.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
		await frame(host, testInfo, 'bulk-deleted-toast');

		// One bulk Undo of 3 songs: a watching guest re-reads Library at most twice, not once per song.
		await guest.goto('/library');
		await expect(guest.locator('main [data-testid="song-add"]')).toHaveCount(1);
		let guestReads = 0;
		guest.on('request', (r) => {
			if (new URL(r.url()).pathname === '/api/library') guestReads++;
		});
		await host.getByRole('button', { name: 'Undo' }).click();
		await expect(rows).toHaveCount(4);
		await expect(guest.locator('main [data-testid="song-add"]')).toHaveCount(4);
		expect(guestReads).toBeLessThanOrEqual(2);
		await expect(host.getByTestId('pick-all')).toBeFocused();
		expect((await libraryIds(guest)).length).toBe(4);

		// Delete every row on screen: Select all is no longer drawn, so focus goes to Done. After Undo it goes back
		// to Select all, but only once the row has returned.
		await filter.fill('caroline');
		await expect(rows).toHaveCount(1);
		await host.getByTestId('pick-all').click();
		await bar.getByRole('button', { name: 'Delete' }).click();
		await expect(rows).toHaveCount(0);
		await expect(host.getByTestId('pick-all')).toHaveCount(0);
		await expect(host.getByTestId('manage-toggle')).toBeFocused();
		await host.getByRole('button', { name: 'Undo' }).click();
		await expect(rows).toHaveCount(1);
		await expect(host.getByTestId('pick-all')).toBeFocused();

		// Delete the whole library: neither Select all nor Done is drawn, so focus goes to the empty screen's Find a song.
		await filter.fill('');
		await expect(rows).toHaveCount(4);
		await rows.filter({ hasText: 'Kept' }).getByRole('checkbox').click();
		await bar.getByRole('button', { name: 'Keep off' }).click();
		await expect(rows.filter({ hasText: 'Kept' })).toHaveCount(0);
		await host.getByTestId('pick-all').click();
		await expect(bar).toContainText('4 picked');
		await bar.getByRole('button', { name: 'Delete' }).click();
		await expect(host.getByText('4 songs deleted')).toBeVisible();
		await expect(rows).toHaveCount(0);
		await expect(host.getByTestId('manage-toggle')).toHaveCount(0);
		await expect(host.getByTestId('library-find')).toBeFocused();
	} finally {
		await worker.stop();
	}
});

test("the host's turn comes while songs are picked: You're up sits over the bar, and its button takes the tap", async ({
	world
}, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const guest = await world.openPhone('Di');
		for (const track of ['caroline', 'believin']) await readySong(world, guest, track);
		const tv = await world.openTv();
		await queueReady(guest, 'caroline');
		const intro = tv.locator(SEL.stateNext);
		await expect(intro).toBeVisible({ timeout: 30_000 });
		await expect(intro).toBeHidden({ timeout: 10_000 });

		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await queueReady(host, 'believin');
		await host.goto('/library');
		await host.getByRole('button', { name: 'Manage' }).click();
		await host.locator('[data-testid="manage-row"]').first().getByRole('checkbox').click();
		const bar = host.locator('[data-testid="bulk-bar"]');
		await expect(bar).toContainText('1 picked');

		// The guest's song ends early: the host's turn starts while the bar is up.
		await transportTap(guest, 'skip');
		const card = host.getByTestId('youre-up-flood');
		await expect(card).toBeVisible({ timeout: 5_000 });
		// No edge of the bar shows outside the card, measured once the card has finished arriving.
		await card.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
		const [barBox, cardBox] = [(await bar.boundingBox())!, (await card.boundingBox())!];
		expect(barBox.y).toBeGreaterThanOrEqual(cardBox.y);
		expect(barBox.y + barBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
		expect(barBox.x).toBeGreaterThanOrEqual(cardBox.x - 0.5);
		expect(barBox.x + barBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
		await frame(host, testInfo, 'bar-under-youre-up');
		// The flood is on top wherever the two share space, so its Restart button is what a tap reaches.
		const ok = card.getByRole('button', { name: 'Restart' });
		const box = (await ok.boundingBox())!;
		const hit = await host.evaluate(
			([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="youre-up-flood"]'),
			[box.x + box.width / 2, box.y + box.height / 2]
		);
		expect(hit).toBe(true);
	} finally {
		await worker.stop();
	}
});

test("a song in tonight's queue cannot be deleted, and a rename reaches the TV at once", async ({
	world
}, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const tv = await world.openTv();
		const guest = await world.openPhone('Bo');
		await readySong(world, guest, 'bohemian');
		await readySong(world, guest, 'prayer');
		const id = (await world.awaitDemoTrack('prayer')).id;
		// Two turns, so the second is still waiting while the first plays.
		await queueReady(guest, 'bohemian');
		await queueReady(guest, 'prayer');

		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		const refused = await host.request.post('/api/library/manage/delete', { data: { mediaId: id } });
		expect(refused.status()).toBe(409);
		expect(((await refused.json()) as { reason?: string }).reason).toBe('queued');

		// The shortest phone: the opened sheet scrolls clear of the dock, so its message is readable without a scroll.
		await host.setViewportSize({ width: 320, height: 568 });
		await host.goto('/library');
		await host.getByRole('button', { name: 'Manage' }).click();
		const row = host.locator('[data-testid="manage-row"]', { hasText: 'prayer' });
		await row.locator('button.open').click();
		const sheet = host.locator('[data-testid="song-sheet"]');
		const message = sheet.getByText("In tonight's queue. Delete it after its turn.");
		await expect(message).toBeVisible();
		const dockTop = await host
			.locator(SEL.dock)
			.first()
			.evaluate((d) => d.getBoundingClientRect().top);
		await expect
			.poll(async () => {
				const box = await message.boundingBox();
				return box ? box.y + box.height : Infinity;
			})
			.toBeLessThanOrEqual(dockTop);
		await host.setViewportSize({ width: 390, height: 844 });
		await expect(sheet.getByRole('button', { name: 'Delete' })).toHaveCount(0);
		await frame(host, testInfo, 'queued-sheet');

		const renamed = await host.request.post('/api/library/manage/rename', {
			data: { mediaId: id, title: 'Prayer Renamed', artist: 'Bon Jovi' }
		});
		expect(renamed.status()).toBe(200);
		await expect(tv.getByText('Prayer Renamed').first()).toBeVisible({ timeout: 5_000 });
	} finally {
		await worker.stop();
	}
});
