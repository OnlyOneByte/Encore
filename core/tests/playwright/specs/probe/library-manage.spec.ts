// Proposal 33 PR 1: the host's Manage on the Library tab, and a guest's Library with none of it.
// See docs/FRONTEND.md#the-library-page and docs/SERVER.md#managing-the-library.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../world/fixtures';
import { queueReady, readySong } from '../../world/actors';
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
		expect(await libraryIds(guest)).not.toContain(id);
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

		await host.goto('/library');
		await host.getByRole('button', { name: 'Manage' }).click();
		const row = host.locator('[data-testid="manage-row"]', { hasText: 'prayer' });
		await row.locator('button.open').click();
		const sheet = host.locator('[data-testid="song-sheet"]');
		await expect(sheet).toContainText("In tonight's queue. Delete it after its turn.");
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
