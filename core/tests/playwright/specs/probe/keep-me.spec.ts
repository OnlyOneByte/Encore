// Keep me on a real phone: offered only after a first song, kept in one tap, welcomed back in one tap after a Leave,
// never welcomed back by name alone, and gone after Delete me. The TV never hears of a person. Proposal 30, PR 2.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { queueReady, readySong, singOnce } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { Page } from '@playwright/test';

const KEEP = (name: string) => `Keep ${name} for next time`;

/** Leave as the real You tab does, then land on the scanned identity pane. */
async function leaveAndRescan(phone: Page, code: string): Promise<void> {
	await phone.goto('/settings/you');
	await phone.getByRole('button', { name: 'Leave the room' }).click();
	await phone.getByRole('button', { name: 'Yes, leave' }).click();
	await phone.waitForURL((u) => u.pathname === '/');
	await phone.goto(`/?room=${encodeURIComponent(code)}`);
}

test('Keep me after the first song, back in one tap, and gone after Delete me', async ({ world, browser }) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world);
	try {
		const tv = await world.openTv();
		const tvFrames: string[] = [];
		tv.on('websocket', (ws) => ws.on('framereceived', (f) => tvFrames.push(String(f.payload))));
		// openTv's socket may already be open before the listener exists, so open a fresh one under it.
		await tv.reload();

		const theo = await world.openPhone('Theo');
		await theo.goto('/settings/you');
		await expect(theo.getByRole('button', { name: 'Leave the room' })).toBeVisible();
		await expect(theo.getByText(KEEP('Theo'))).toHaveCount(0);

		await readySong(world, theo, 'caroline');
		await theo.goto('/');
		await singOnce(theo, 'caroline');

		await theo.goto('/settings/you');
		await expect(theo.getByRole('heading', { name: KEEP('Theo') })).toBeVisible();
		expect(await theo.locator('[role="dialog"], [role="alertdialog"]').count()).toBe(0);
		await theo.getByRole('button', { name: 'Keep me', exact: true }).click();
		await expect(theo.getByRole('heading', { name: 'Theo is kept on this phone' })).toBeVisible();
		const cookies = await theo.context().cookies();
		const device = cookies.find((c) => c.name === 'encore_device');
		expect(device?.httpOnly).toBe(true);
		expect(device?.sameSite).toBe('Lax');

		// A thief copies the device cookie (plain HTTP can be sniffed) onto another phone.
		const thief = await (await browser.newContext({ baseURL: world.baseURL })).newPage();
		await thief.context().addCookies([{ ...device!, sameSite: 'Lax' }]);
		await thief.goto(`/?room=${encodeURIComponent(world.code)}`);
		await expect(thief.getByRole('heading', { name: 'Welcome back, Theo' })).toBeVisible();

		// Next night: Leave, scan again, and the only thing to do is one tap.
		await leaveAndRescan(theo, world.code);
		await expect(theo.getByRole('heading', { name: 'Welcome back, Theo' })).toBeVisible();
		await expect(theo.locator(SEL.nameInput)).toHaveCount(0);

		// Party Wi-Fi drops the join's response: the server joined and rotated, the phone never heard.
		let dropped = false;
		await theo.route('**/api/join', async (route) => {
			if (dropped) return route.continue();
			dropped = true;
			// route.fetch() files the response's Set-Cookie in this context, so put the jar back as the phone had it.
			const jar = await theo.context().cookies();
			await route.fetch();
			await theo.context().clearCookies();
			await theo.context().addCookies(jar);
			await route.abort('connectionreset');
		});
		await theo.getByRole('button', { name: SEL.submit }).click();
		await expect(theo.locator(SEL.joinError)).toBeVisible();
		const deviceNow = async () => (await theo.context().cookies()).find((c) => c.name === 'encore_device')?.value;
		expect(await deviceNow(), 'the lost response must not have reached the cookie jar').toBe(device!.value);

		// The retry works: the old token is inside its grace, so it is answered with the current one.
		const tapped = Date.now();
		await theo.getByRole('button', { name: SEL.submit }).click();
		await theo.locator(SEL.search).waitFor();
		console.log(`kept phone: tap Start singing -> Sing box ${Date.now() - tapped} ms (incl. the join's reload)`);
		await theo.unroute('**/api/join');
		const me = await theo.request.get('/api/me').then((r) => r.json());
		expect(me.singer.displayName).toBe('Theo');
		expect(await deviceNow()).not.toBe(device!.value);

		// Theo's socket opening on the new token ends the grace, with no further page load: the copy is refused.
		await theo.locator(SEL.dock).waitFor({ state: 'attached' });
		await expect
			.poll(
				async () =>
					(
						(await thief.request.get(`/api/room-preview?code=${world.code}`).then((r) => r.json())) as {
							returning: unknown;
						}
					).returning,
				{ message: "the thief's copy was still welcomed after Theo's socket opened" }
			)
			.toBeNull();
		await thief.reload();
		await expect(thief.locator(SEL.nameInput)).toBeVisible();
		await expect(thief.getByText('Welcome back')).toHaveCount(0);
		const stolen = await thief.request.post('/api/join', { data: { returning: true, code: world.code } });
		expect(stolen.status()).toBe(401);
		await thief.context().close();

		// The name is never a credential: another phone typing it is a new guest, refused while Theo holds it.
		const stranger = await (await browser.newContext({ baseURL: world.baseURL })).newPage();
		await stranger.goto(`/?room=${encodeURIComponent(world.code)}`);
		await expect(stranger.getByText('Welcome back')).toHaveCount(0);
		await expect(stranger.locator(SEL.nameInput)).toBeVisible();
		await stranger.context().close();

		// Delete me: confirmed in a dialog, then this phone forgets Theo and is not welcomed back.
		await theo.goto('/settings/you');
		await theo.getByRole('button', { name: 'Delete me' }).click();
		await expect(theo.locator('[role="alertdialog"]')).toContainText('You stay in the room tonight');
		await theo.getByRole('button', { name: 'Yes, delete me' }).click();
		await expect(theo.getByRole('heading', { name: 'Theo is kept on this phone' })).toHaveCount(0);
		await expect(theo.getByText(KEEP('Theo'))).toHaveCount(0);
		expect((await theo.context().cookies()).some((c) => c.name === 'encore_device')).toBe(false);
		await leaveAndRescan(theo, world.code);
		await expect(theo.locator(SEL.nameInput)).toBeVisible();
		await expect(theo.getByText('Welcome back')).toHaveCount(0);

		// Nothing about a person, a device or a token reached the TV.
		expect(tvFrames.length).toBeGreaterThan(0);
		expect(tvFrames.join('\n')).not.toMatch(/personId|person_id|deviceId|sessionToken|encore_device/);
	} finally {
		await worker.stop();
	}
});

test('after a reset, a turn still queued under the name keeps the name until it is done', async ({
	world,
	browser
}) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world);
	try {
		await world.openTv();
		const theo = await world.openPhone('Theo');
		await readySong(world, theo, 'caroline');
		await theo.goto('/');
		await singOnce(theo, 'caroline');
		await theo.goto('/settings/you');
		await theo.getByRole('button', { name: 'Keep me', exact: true }).click();
		await expect(theo.getByRole('heading', { name: 'Theo is kept on this phone' })).toBeVisible();
		await expect(theo.locator(SEL.npStripTitle)).toHaveCount(0, { timeout: 30_000 });

		// Ana has not sung yet, so her song plays first and Theo's waits, queued, behind it.
		const ana = await world.openPhone('Ana');
		await queueReady(ana, 'caroline');
		await theo.goto('/');
		await queueReady(theo, 'caroline');

		const host = await (await browser.newContext({ baseURL: world.baseURL })).newPage();
		await world.becomeHost(host);
		await host.goto('/host');
		await host.getByRole('button', { name: "Reset Theo's phones" }).click();
		await host.getByRole('button', { name: 'Yes, reset' }).click();
		await expect(host.getByRole('button', { name: "Reset Theo's phones" })).toHaveCount(0);

		const stranger = await (await browser.newContext({ baseURL: world.baseURL })).newPage();
		const tryTheo = () => stranger.request.post('/api/join', { data: { displayName: 'Theo', code: world.code } });
		expect((await tryTheo()).status(), "a new guest took the name Theo's queued turn waits under").toBe(409);

		// Both songs play out (8 s each); once Theo's turn is done, the name is free with no grace window.
		await expect.poll(async () => (await tryTheo()).status(), { timeout: 90_000, intervals: [1_000] }).toBe(200);
		await stranger.context().close();
		await host.context().close();
	} finally {
		await worker.stop();
	}
});

test("the host's Reset phones signs out every phone of a kept person, and they can keep themselves again", async ({
	world,
	browser
}) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world);
	try {
		await world.openTv();
		const theo = await world.openPhone('Theo');
		await readySong(world, theo, 'caroline');
		await theo.goto('/');
		await singOnce(theo, 'caroline');
		await theo.goto('/settings/you');
		await theo.getByRole('button', { name: 'Keep me', exact: true }).click();
		await expect(theo.getByRole('heading', { name: 'Theo is kept on this phone' })).toBeVisible();
		// His song is over, so nothing holds the name once he is reset (the held case is the test above).
		await expect(theo.locator(SEL.npStripTitle)).toHaveCount(0, { timeout: 30_000 });
		const device = (await theo.context().cookies()).find((c) => c.name === 'encore_device')!;
		const copy = await (await browser.newContext({ baseURL: world.baseURL })).newPage();
		await copy.context().addCookies([{ ...device, sameSite: 'Lax' }]);

		// A guest has no Reset control and the route refuses them.
		await theo.goto('/host');
		await expect(theo.getByRole('heading', { name: 'Kept phones' })).toHaveCount(0);
		const refused = await theo.request.post('/api/host/people/reset', { data: { personId: 'anyone' } });
		expect(refused.status()).toBe(403);

		const host = await (
			await browser.newContext({ baseURL: world.baseURL, viewport: { width: 390, height: 844 } })
		).newPage();
		await world.becomeHost(host);
		await host.goto('/host');
		await expect(host.getByRole('heading', { name: 'Kept phones' })).toBeVisible();
		await host.getByRole('button', { name: "Reset Theo's phones" }).click();
		await expect(host.locator('[role="alertdialog"]')).toContainText('Every phone kept as Theo is signed out');
		await host.getByRole('button', { name: 'Yes, reset' }).click();
		await expect(host.getByRole('button', { name: "Reset Theo's phones" })).toHaveCount(0);

		// Neither the phone nor the copy is welcomed back; Theo's night ended, so the phone is back at the join.
		for (const page of [theo, copy]) {
			const preview = await page.request.get(`/api/room-preview?code=${world.code}`).then((r) => r.json());
			expect(preview.returning).toBeNull();
		}
		await expect.poll(async () => (await theo.request.get('/api/me')).status()).toBe(401);

		// Theo joins fresh and, after a song, is offered Keep me again.
		await world.joinAs(theo, 'Theo');
		await singOnce(theo, 'caroline');
		await theo.goto('/settings/you');
		await expect(theo.getByRole('heading', { name: KEEP('Theo') })).toBeVisible();
		await copy.context().close();
		await host.context().close();
	} finally {
		await worker.stop();
	}
});

test("the owner's return ends a thief's copied night, live socket and all (#1250)", async ({ world, browser }) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world);
	try {
		await world.openTv();
		const theo = await world.openPhone('Theo');
		await readySong(world, theo, 'caroline');
		await theo.goto('/');
		await singOnce(theo, 'caroline');
		await theo.goto('/settings/you');
		await theo.getByRole('button', { name: 'Keep me', exact: true }).click();
		await expect(theo.getByRole('heading', { name: 'Theo is kept on this phone' })).toBeVisible();
		await expect(theo.locator(SEL.npStripTitle)).toHaveCount(0, { timeout: 30_000 });

		// A thief copies BOTH cookies and stays in the room as Theo, socket open.
		const jar = await theo.context().cookies();
		const thief = await (await browser.newContext({ baseURL: world.baseURL })).newPage();
		await thief.context().addCookies(jar.map((c) => ({ ...c, sameSite: 'Lax' as const })));
		const thiefSockets: Promise<void>[] = [];
		thief.on('websocket', (ws) => thiefSockets.push(new Promise((done) => ws.on('close', () => done()))));
		await thief.goto('/');
		await thief.locator(SEL.dock).waitFor({ state: 'attached' });
		expect((await thief.request.get('/api/me')).status()).toBe(200);
		await expect.poll(() => thiefSockets.length).toBeGreaterThan(0);
		// The sockets open now; a reconnect after the server closes them is a new one, and has no singer.
		const live = [...thiefSockets];

		// Theo's phone comes back with only its device cookie and returns in one tap, which rotates the token.
		await theo.context().clearCookies();
		await theo.context().addCookies(jar.filter((c) => c.name === 'encore_device'));
		await theo.goto(`/?room=${encodeURIComponent(world.code)}`);
		await expect(theo.getByRole('heading', { name: 'Welcome back, Theo' })).toBeVisible();
		const joined = theo.waitForResponse((r) => r.url().endsWith('/api/join'));
		await theo.getByRole('button', { name: SEL.submit }).click();
		// Before #1250 the thief's live night kept the name, so this was "That name is taken".
		expect((await joined).status(), "the owner's return was refused while the thief held the name").toBe(200);
		await theo.locator(SEL.search).waitFor();
		expect((await theo.request.get('/api/me').then((r) => r.json())).singer.displayName).toBe('Theo');

		// The thief's night is over: its socket is closed by the server and its copied singer cookie is refused.
		await Promise.race([
			Promise.all(live),
			new Promise((_, fail) => setTimeout(() => fail(new Error("the thief's socket stayed open")), 10_000))
		]);
		await expect.poll(async () => (await thief.request.get('/api/me')).status()).toBe(401);
		await thief.context().close();
	} finally {
		await worker.stop();
	}
});

test('"I\'m someone else" on a kept phone joins as a new guest and leaves the phone kept', async ({ world }) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world);
	try {
		const ana = await world.openPhone('Ana');
		await readySong(world, ana, 'caroline');
		await ana.goto('/');
		await singOnce(ana, 'caroline');
		await ana.goto('/settings/you');
		await ana.getByRole('button', { name: 'Keep me', exact: true }).click();
		await expect(ana.getByRole('heading', { name: 'Ana is kept on this phone' })).toBeVisible();

		await leaveAndRescan(ana, world.code);
		await ana.getByRole('button', { name: "I'm someone else" }).click();
		await ana.locator(SEL.nameInput).fill('Borrower');
		await ana.getByRole('button', { name: SEL.submit }).click();
		await ana.locator(SEL.dock).waitFor({ state: 'attached' });
		expect((await ana.request.get('/api/me').then((r) => r.json())).singer.displayName).toBe('Borrower');
		// A borrowed kept phone offers nothing about Keep me, and Ana is still kept on it.
		await ana.goto('/settings/you');
		await expect(ana.getByText(KEEP('Borrower'))).toHaveCount(0);
		await expect(ana.getByRole('heading', { name: /is kept on this phone/ })).toHaveCount(0);
		const preview = await ana.request.get(`/api/room-preview?code=${world.code}`).then((r) => r.json());
		expect(preview.returning?.displayName).toBe('Ana');
	} finally {
		await worker.stop();
	}
});
