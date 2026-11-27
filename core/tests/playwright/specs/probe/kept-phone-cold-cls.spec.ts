// A KEPT PHONE'S COLD LOAD HOLDS STILL (#1399). Theo kept himself on this phone and left; next night he scans the
// room again. The page paints its pending placeholder, the room answers "not joined", and the join screen ("Welcome
// back, Theo") takes its place. `<main>` moved as it did (CLS 0.05 at 1280, in 33 of 40 loads on main): the cold-load
// CLS checks in p22 never load a kept phone. Twenty loads on Theo's own phone, each after a real Leave, then twenty in
// fresh contexts carrying only the device cookie, the CPU slowed 4x so the swap lands over more than one frame.
// Nobody touches anything, so every entry counts.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { readySong, singOnce } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { BrowserContext, Page } from '@playwright/test';

type Shift = { value: number; sources: string[] };
const LOADS = 20;
const RATE = 4;
// From --bp-md up the join screen centres in the shell, so an empty `<main>` painted first moved when it arrived.
// At 390 nothing centres and the same swap never shifted (0 of 120 loads on main).
const VIEW = { width: 1280, height: 720 };

async function observeShifts(context: BrowserContext): Promise<void> {
	await context.addInitScript(() => {
		const w = window as unknown as { __shifts: Shift[] };
		w.__shifts = [];
		new PerformanceObserver((list) => {
			for (const e of list.getEntries() as unknown as {
				value: number;
				hadRecentInput: boolean;
				sources: { node?: Node | null }[];
			}[]) {
				if (e.hadRecentInput) continue;
				const name = (n?: Node | null) =>
					n instanceof Element ? `${n.tagName.toLowerCase()}.${n.className}` : String(n?.nodeName);
				w.__shifts.push({ value: e.value, sources: e.sources.map((s) => name(s.node)) });
			}
		}).observe({ type: 'layout-shift', buffered: true });
	});
}

/** One load of the scanned join, read once the welcome is up and two frames past the swap. */
async function coldLoad(page: Page, code: string): Promise<{ cls: number; shifts: Shift[] }> {
	await page.goto(`/?room=${encodeURIComponent(code)}`);
	await expect(page.getByRole('heading', { name: 'Welcome back, Theo' })).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(500);
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
	const shifts = await page.evaluate(() => (window as unknown as { __shifts: Shift[] }).__shifts);
	return { cls: shifts.reduce((sum, s) => sum + s.value, 0), shifts };
}

test('a kept phone cold-loads the join screen with no layout shift (#1399)', async ({ world, browser }) => {
	test.setTimeout(300_000);
	const worker = await startFakeWorker(world);
	const theo = await world.openPhone('Theo');
	try {
		await readySong(world, theo, 'caroline');
		await theo.goto('/');
		await singOnce(theo, 'caroline');
	} finally {
		await worker.stop();
	}
	await theo.goto('/settings/you');
	const kept = theo.waitForResponse((r) => r.url().endsWith('/api/me/person') && r.request().method() === 'POST');
	await theo.getByRole('button', { name: 'Keep me', exact: true }).click();
	expect((await kept).status()).toBe(200);
	await theo.getByRole('button', { name: 'Leave the room' }).click();
	await theo.getByRole('button', { name: 'Yes, leave' }).click();
	await theo.waitForURL((u) => u.pathname === '/');
	expect(
		(await theo.context().cookies()).some((c) => c.name === 'encore_device'),
		'Keep me set no device cookie'
	).toBe(true);

	const runs: { path: string; load: number; cls: number; shifts: Shift[] }[] = [];
	await theo.setViewportSize(VIEW);
	await observeShifts(theo.context());
	await (await theo.context().newCDPSession(theo)).send('Emulation.setCPUThrottlingRate', { rate: RATE });
	for (let i = 0; i < LOADS; i++) {
		runs.push({ path: 'own phone', load: i + 1, ...(await coldLoad(theo, world.code)) });
		// Back in with one tap, then Leave as the You tab does, so the next load follows a real night's Leave.
		await theo.getByRole('button', { name: SEL.submit }).click();
		await theo.locator(SEL.search).waitFor();
		await theo.goto('/settings/you');
		await theo.getByRole('button', { name: 'Leave the room' }).click();
		await theo.getByRole('button', { name: 'Yes, leave' }).click();
		await theo.waitForURL((u) => u.pathname === '/');
	}

	// Read after the rejoins above: each one rotates the device token.
	const device = (await theo.context().cookies()).find((c) => c.name === 'encore_device');
	for (let i = 0; i < LOADS; i++) {
		const context = await browser.newContext({ baseURL: world.baseURL, viewport: VIEW });
		try {
			await context.addCookies([{ ...device!, sameSite: 'Lax' }]);
			await observeShifts(context);
			const page = await context.newPage();
			await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: RATE });
			runs.push({ path: 'fresh context', load: i + 1, ...(await coldLoad(page, world.code)) });
		} finally {
			await context.close();
		}
	}
	const shifted = runs.filter((r) => r.cls > 0);
	console.log(
		`kept-phone cold loads: ${runs.length - shifted.length}/${runs.length} with CLS 0`,
		JSON.stringify(shifted)
	);
	expect(shifted, 'a kept phone cold load shifted its layout').toEqual([]);
});
