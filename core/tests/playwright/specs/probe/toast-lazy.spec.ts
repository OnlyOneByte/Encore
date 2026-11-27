// The toaster loads with the first toast (#1309): no toast is lost or late, on a cold load, across a tab change,
// offline under the service worker, and on a first visit whose toaster chunk fails once (from the #1394 review).
import { test, expect, type World } from '../../world/fixtures';
import { readySong, goOffline } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { Browser, Page } from '@playwright/test';

const TRACKS = ['caroline', 'bohemian', 'prayer'];

async function hostOnManage(world: World): Promise<Page> {
	const guest = await world.openPhone('Ana');
	for (const t of TRACKS) await readySong(world, guest, t);
	const host = await world.openPhone('Host');
	await world.becomeHost(host);
	return host;
}

async function openManage(host: Page) {
	await host.goto('/library');
	await host.getByRole('button', { name: 'Manage' }).click();
	await expect(host.locator('[data-testid="manage-row"]')).toHaveCount(TRACKS.length);
}

async function deleteFirst(host: Page) {
	await host.locator('[data-testid="manage-row"] button.open').first().click();
	await host.locator('[data-testid="song-sheet"]').getByRole('button', { name: 'Delete' }).click();
}

/** A host phone on a FIRST visit (no service worker yet) whose toaster chunk fails `times` times. */
async function firstVisitHost(world: World, browser: Browser, times: number) {
	const guest = await world.openPhone('Ana');
	for (const t of TRACKS) await readySong(world, guest, t);
	const ctx = await browser.newContext({
		baseURL: world.baseURL,
		serviceWorkers: 'block',
		viewport: { width: 390, height: 844 }
	});
	const host = await ctx.newPage();
	const headers = { origin: world.baseURL };
	expect(
		(await host.request.post('/api/join', { data: { displayName: 'Host', color: '#ff8800' }, headers })).ok()
	).toBe(true);
	expect(
		(await host.request.post('/api/host', { data: { key: 'playwright-host-key-not-a-secret' }, headers })).ok()
	).toBe(true);
	const state: { aborted: number; seen: number; onlineFired?: boolean } = { aborted: 0, seen: 0 };
	// A predicate, not a glob: the retry's `?retry=N` URL must be counted too.
	await ctx.route(
		(u) => u.pathname.startsWith('/_app/immutable/chunks/') && u.pathname.endsWith('.js'),
		async (route) => {
			const res = await route.fetch();
			const body = await res.text();
			if (!body.includes('data-sonner-toaster')) return route.fulfill({ response: res, body });
			state.seen++;
			if (state.aborted < times) {
				state.aborted++;
				return route.abort('failed');
			}
			return route.fulfill({ response: res, body });
		}
	);
	return { host, state, ctx };
}

test('cold load: the first toast shows at once, lasts, and Undo works', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const host = await hostOnManage(world);
		await openManage(host);
		expect(await host.locator('[data-sonner-toaster]').count(), 'toaster mounted before any toast').toBe(0);
		const t0 = Date.now();
		await deleteFirst(host);
		const undo = host.getByRole('button', { name: 'Undo' });
		await expect(undo).toBeVisible({ timeout: 3000 });
		console.log('first toast visible after', Date.now() - t0, 'ms');
		for (const width of [390, 320]) {
			await host.setViewportSize({ width, height: 844 });
			await host.waitForTimeout(400);
			const t = host.locator('[data-sonner-toast]').first();
			const look = await t.evaluate((el) => {
				const s = getComputedStyle(el);
				const r = el.getBoundingClientRect();
				return {
					bg: s.backgroundColor,
					border: s.border,
					radius: s.borderRadius,
					pad: s.padding,
					font: s.fontSize + ' ' + s.fontFamily.slice(0, 30),
					color: s.color,
					x: Math.round(r.x),
					w: Math.round(r.width),
					h: Math.round(r.height),
					bottom: Math.round(innerHeight - r.bottom)
				};
			});
			const sheets = await host.evaluate(
				() =>
					[...document.querySelectorAll('style,link[rel=stylesheet]')].filter((n) =>
						(n.textContent ?? '').includes('data-sonner-toaster')
					).length
			);
			console.log(JSON.stringify({ width, look, sonnerStyleTags: sheets }));
			await host.screenshot({ path: test.info().outputPath(`toast-${width}.png`) });
		}
		await host.setViewportSize({ width: 390, height: 844 });
		await undo.click();
		await expect(host.locator('[data-testid="manage-row"]')).toHaveCount(TRACKS.length);
	} finally {
		await worker.stop();
	}
});

test('a toast fired just before a tab change still shows on the next tab', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const host = await hostOnManage(world);
		await openManage(host);
		await deleteFirst(host);
		await host.locator('.tabs .tab').filter({ hasText: 'Queue' }).first().click();
		await expect(host).toHaveURL(/\/queue$/);
		await expect(host.getByText(/deleted/).first()).toBeVisible({ timeout: 3000 });
	} finally {
		await worker.stop();
	}
});

test('offline, with the service worker in control, a toast still shows', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const host = await hostOnManage(world);
		await openManage(host);
		await expect.poll(() => host.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20_000 }).toBe(true);
		await host.evaluate(() => navigator.serviceWorker.ready.then(() => true));
		await goOffline(host);
		await deleteFirst(host);
		await expect(host.getByText("Couldn't reach the server")).toBeVisible({ timeout: 5000 });
	} finally {
		await worker.stop();
	}
});

test('the chunk fails once while online: the next toast refetches it, and the held toast shows too', async ({
	world,
	browser
}) => {
	const worker = await startFakeWorker(world);
	try {
		const { host, state } = await firstVisitHost(world, browser, 1);
		await openManage(host);
		await deleteFirst(host);
		await host.waitForTimeout(1500);
		const firstShown = await host.getByRole('button', { name: 'Undo' }).isVisible();
		await deleteFirst(host);
		// Both deletes' toasts, each with its Undo: the first was held while the toaster could not load.
		await expect(host.locator('[data-sonner-toast]').filter({ hasText: /deleted/ })).toHaveCount(2, { timeout: 5000 });
		console.log(JSON.stringify({ ...state, firstShown }));
		expect(state.aborted, 'the probe never failed the chunk').toBe(1);
		expect(state.seen, 'the retry did not fetch the chunk again').toBe(2);
	} finally {
		await worker.stop();
	}
});

test('the chunk fails once, then the phone goes offline and back online: toasts come back', async ({
	world,
	browser
}) => {
	const worker = await startFakeWorker(world);
	try {
		const { host, state } = await firstVisitHost(world, browser, 1);
		await openManage(host);
		await deleteFirst(host);
		await host.waitForTimeout(1000);
		await host.evaluate(() => {
			(window as unknown as { onlineFired: boolean }).onlineFired = false;
			window.addEventListener('online', () => ((window as unknown as { onlineFired: boolean }).onlineFired = true));
		});
		await host.context().setOffline(true);
		await host.waitForTimeout(300);
		await host.context().setOffline(false);
		await host.waitForTimeout(1500);
		state.onlineFired = await host.evaluate(() => (window as unknown as { onlineFired: boolean }).onlineFired);
		console.log(JSON.stringify(state));
		await expect(host.locator('[data-sonner-toaster]')).toHaveCount(1, { timeout: 5000 });
		// The toast pushed while the chunk failed shows once the toaster mounts.
		await expect(host.getByText(/deleted/).first()).toBeVisible({ timeout: 3000 });
		expect(state.seen, 'going back online did not fetch the chunk again').toBe(2);
		await deleteFirst(host);
		await expect(host.getByText(/deleted/).first()).toBeVisible({ timeout: 3000 });
	} finally {
		await worker.stop();
	}
});
