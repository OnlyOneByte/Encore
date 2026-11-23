// ONE PHONE, ONE SINGER, IN EVERY TAB (proposal 20). Two tabs of one phone browser share one session cookie, so
// they are one guest. Before this, a Leave in tab B left tab A saying "Maya" and still queuing songs the TV sang as
// "NOW SINGING Maya", a guest who had gone home; and after B joined as Theo, tab A kept saying Maya while its socket,
// on a reconnect, acted as Theo.
//
// Now: a Leave closes every socket of the leaver and ends the token on the server; the tab that joined or left says
// so on a BroadcastChannel; every other tab asks /api/me again, and a tab coming to the front asks too. A 401 is the
// join screen with the name filled in; a different singer reloads the tab as them.
//
// The last test is the security check: every op from a left session (a replayed cookie), a cookieless socket and a
// rejoined session, over HTTP and the socket.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { DEMO_LIBRARY } from '../../world/seed';
import { readySong, queueReady } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';

const LOST = "You're not in the room any more. Join again to sing.";
// Media for the PR, only when asked for: `P20_SHOTS=/dir`.
const SHOTS = process.env.P20_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (p: Page, name: string) => {
	if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` });
};

const meName = (p: Page) => p.locator('.me-name').first();

/** Tab A joined as `name` on a phone of this width; tab B is a second tab of the SAME browser, so the same cookie. */
async function twoTabs(browser: Browser, world: World, name: string, width: number) {
	const context = await browser.newContext({
		viewport: { width, height: width === 320 ? 568 : 844 },
		baseURL: world.baseURL
	});
	const a = await context.newPage();
	await world.joinAs(a, name);
	const b = await context.newPage();
	await b.goto('/');
	await b.locator(SEL.dock).waitFor({ state: 'attached' });
	await expect(meName(b)).toHaveText(name);
	return { context, a, b };
}

/** Leave through the real You pane, as a guest does. */
async function leaveFrom(tab: Page): Promise<void> {
	await tab.goto('/settings/you');
	await tab.getByRole('button', { name: 'Leave the room' }).click();
	await tab.getByRole('button', { name: 'Yes, leave' }).click();
	await tab.waitForURL((u) => u.pathname === '/');
}

/** The tab that tapped Leave: the join screen with no "not in the room any more" line, as on main. Read twice, the
 *  second time well past the server's close and a re-check, so a late line cannot slip in after the first look. */
async function leaverSeesPlainJoin(tab: Page): Promise<void> {
	await expect(tab.locator(SEL.joinColumn).first()).toBeVisible();
	for (const wait of [0, 2_000]) {
		await tab.waitForTimeout(wait);
		expect((await tab.locator('.lost').allTextContents()).join('').trim(), 'the leaver was told they were removed').toBe(
			''
		);
		expect(await tab.getByText(LOST).count()).toBe(0);
		expect(await tab.locator(SEL.dock).count(), 'the dock outlived the leave').toBe(0);
	}
}

test('the only tab that taps Leave lands on the plain join screen', async ({ browser, world }) => {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: world.baseURL });
	const a = await context.newPage();
	await world.joinAs(a, 'Maya');
	await leaveFrom(a);
	await leaverSeesPlainJoin(a);
	await shot(a, 'phone-leaver-one-tab-390');
	await context.close();
});

test('with two tabs, the one that taps Leave lands on the plain join screen; the other is told', async ({
	browser,
	world
}) => {
	const { context, a, b } = await twoTabs(browser, world, 'Maya', 390);
	await leaveFrom(b);
	await leaverSeesPlainJoin(b);
	await expect(a.getByText(LOST)).toBeVisible({ timeout: 1_000 });
	await context.close();
});

/** What the TV's stage says now, whitespace folded. */
const tvText = async (tv: Page) => (await tv.locator('body').innerText()).replace(/\s+/g, ' ');

for (const width of [390, 320]) {
	test(`${width}: a Leave in one tab puts the other on the join screen; a join there makes it that singer`, async ({
		browser,
		world
	}) => {
		test.setTimeout(180_000);
		const worker = await startFakeWorker(world);
		try {
			const tv = await world.openTv();
			const { context, a, b } = await twoTabs(browser, world, 'Maya', width);
			await readySong(world, a, 'caroline');

			await leaveFrom(b);
			// Within a second: the server closed A's socket and B told A on the channel.
			await expect(a.getByText(LOST)).toBeVisible({ timeout: 1_000 });
			expect(await a.locator(SEL.dock).count(), 'tab A kept the dock of a guest who left').toBe(0);
			await shot(a, `phone-tab-left-${width}`);
			// #996's screen: the name is kept for the identity pane, one code away.
			await a.locator('.code-entry input').first().click();
			await a.keyboard.type(world.code);
			await expect(a.locator(SEL.nameInput)).toHaveValue('Maya', { timeout: 10_000 });

			await world.joinAs(b, 'Theo');
			await a.bringToFront();
			await expect(meName(a)).toHaveText('Theo', { timeout: 1_000 });
			await shot(a, `phone-tab-adopted-${width}`);

			// A's + now queues a turn the TV names as Theo, never as the guest who left.
			await queueReady(a, 'caroline');
			await expect.poll(() => tvText(tv), { timeout: 20_000 }).toMatch(/now singing\s*theo/i);
			expect(await tvText(tv)).not.toMatch(/maya/i);
			if (width === 390) await shot(tv, 'tv-theo-sings');
			await context.close();
		} finally {
			await worker.stop();
		}
	});
}

test('a tab that heard nothing catches up on a reconnect and when it comes to the front', async ({
	browser,
	world
}) => {
	// No tab says anything here: the leave and the join go over the browser's own request API, as a tab whose
	// message a frozen browser never delivered would see it.
	const { context, a, b } = await twoTabs(browser, world, 'Maya', 390);
	await b.close();
	expect((await context.request.post('/api/leave')).status()).toBe(200);
	// The server closed A's socket, so A reconnected, asked, and was told no.
	await expect(a.getByText(LOST)).toBeVisible({ timeout: 2_000 });

	const join = await context.request.post('/api/join', { data: { displayName: 'Theo', code: world.code } });
	expect(join.status()).toBe(200);
	await a.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(meName(a)).toHaveText('Theo', { timeout: 1_000 });
	await context.close();
});

test('a tab frozen in the background while the other one left comes back to the join screen, not an error', async ({
	browser,
	world
}) => {
	const { context, a, b } = await twoTabs(browser, world, 'Maya', 390);
	// Anything "Reconnecting…" or an error toast ever painted in tab A, from here on.
	await a.evaluate(() => {
		const w = window as unknown as { __seen: string[] };
		w.__seen = [];
		new MutationObserver(() => {
			const t = document.body.innerText;
			for (const s of ['Reconnecting', "Couldn't", 'error'])
				if (t.includes(s) && !w.__seen.includes(s)) w.__seen.push(s);
		}).observe(document, { childList: true, subtree: true, characterData: true });
	});
	const cdp = await context.newCDPSession(a);
	await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
	await leaveFrom(b);
	await b.waitForTimeout(2_000);
	await cdp.send('Page.setWebLifecycleState', { state: 'active' });
	await expect(a.getByText(LOST)).toBeVisible({ timeout: 2_000 });
	expect(await a.locator(SEL.dock).count()).toBe(0);
	expect(await a.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toEqual([]);
	await shot(a, 'phone-tab-thawed-390');
	await context.close();
});

/** Open a raw socket from a page of `ctx` (so it carries that context's cookie), send `frames`, and report what came back. */
async function rawSocket(ctx: BrowserContext, frames: unknown[]) {
	const page = await ctx.newPage();
	await page.goto('/health');
	const seen = await page.evaluate(async (frames) => {
		const ws = new WebSocket(`ws://${location.host}/ws?role=phone`);
		const got: { type: string; reason?: string; isPlaying?: boolean }[] = [];
		ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
		await new Promise((r) => (ws.onopen = r));
		for (const f of frames) ws.send(JSON.stringify(f));
		await new Promise((r) => setTimeout(r, 1_500));
		ws.close();
		return got;
	}, frames);
	await page.close();
	return seen;
}

const add = (singerId: string, mediaId: string) => ({
	type: 'queue:command',
	command: {
		clientOpId: `op-${Math.random().toString(36).slice(2)}`,
		op: {
			op: 'add',
			entry: {
				id: `e-${Math.random().toString(36).slice(2)}`,
				mediaId,
				singerId,
				status: 'queued',
				rotationSeq: -1,
				addedAt: Date.now()
			}
		}
	}
});
const OTHER_OPS = [
	{ type: 'player:command', command: { cmd: 'pause' } },
	{ type: 'room:react', kind: 'clap' }
];

test.describe('security', () => {
	// A 40 s song, so Theo is still singing while the left session tries to pause him.
	test.use({ demoLibrary: [[...DEMO_LIBRARY, { file: 'long.wav', seconds: 40, hz: [220] }], { scope: 'test' }] });

	test('a left session, a cookieless socket and a rejoined one can do nothing as the guest who left', async ({
		browser,
		world
	}) => {
		test.setTimeout(180_000);
		const worker = await startFakeWorker(world);
		try {
			const tv = await world.openTv();
			const { context, a, b } = await twoTabs(browser, world, 'Maya', 390);
			await readySong(world, a, 'long');
			const mediaId = (await world.awaitDemoTrack('long')).id;
			const maya = (await (await context.request.get('/api/me')).json()).singer.id as string;
			const token = (await context.cookies()).find((c) => c.name === 'encore_singer')!;

			// A socket held open in tab B: the Leave must close it.
			const held = b.evaluate(
				() =>
					new Promise<number>((resolve) => {
						const ws = new WebSocket(`ws://${location.host}/ws?role=phone`);
						ws.onclose = (e) => resolve(e.code);
					})
			);
			await b.waitForTimeout(500);
			expect((await context.request.post('/api/leave')).status()).toBe(200);
			expect(await held, "the leaver's other socket stayed open").toBe(4001);

			// The same browser, rejoined as Theo: it is Theo, it cannot queue as Maya, and its own turn plays.
			await world.joinAs(a, 'Theo');
			const theo = (await (await context.request.get('/api/me')).json()).singer.id as string;
			const fromTheo = await rawSocket(context, [add(maya, mediaId), add(theo, mediaId)]);
			const rejects = fromTheo.filter((e) => e.type === 'op:reject').map((e) => e.reason);
			expect(rejects).toEqual(['singerId does not match this session']);
			await expect.poll(() => tvText(tv), { timeout: 20_000 }).toMatch(/now singing\s*theo/i);

			// A replayed copy of the cookie that left: every HTTP op is a 401, every socket op acts as nobody.
			const replay = await browser.newContext({ baseURL: world.baseURL });
			await replay.addCookies([{ name: token.name, value: token.value, url: world.baseURL }]);
			expect((await replay.request.get('/api/me')).status()).toBe(401);
			expect((await replay.request.patch('/api/me', { data: { displayName: 'Maya' } })).status()).toBe(401);
			expect((await replay.request.get('/api/leave')).status()).toBe(401);
			expect((await replay.request.post('/api/leave')).status()).toBe(401);
			expect((await replay.request.post('/api/process', { data: { mediaId } })).status()).toBe(401);
			// And a socket with no cookie at all.
			const bare = await browser.newContext({ baseURL: world.baseURL });
			for (const ctx of [replay, bare]) {
				const seen = await rawSocket(ctx, [add(maya, mediaId), ...OTHER_OPS]);
				expect(seen.find((e) => e.type === 'op:reject')?.reason).toBe('join the room first');
				// The pause did nothing: no broadcast stopped Theo's song.
				expect(seen.some((e) => e.type === 'playback:state' && e.isPlaying === false)).toBe(false);
			}

			// None of it reached the room: Theo still sings, and the TV never names the guest who left.
			await tv.waitForTimeout(1_000);
			const stage = await tvText(tv);
			// The handoff card has gone by now; the stage still names Theo over his lyrics.
			expect(stage).toMatch(/theo/i);
			expect(stage).not.toMatch(/maya/i);
			for (const c of [replay, bare, context]) await c.close();
		} finally {
			await worker.stop();
		}
	});
});
