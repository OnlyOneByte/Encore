// P22 — THE PHONE NEVER LIES ABOUT BEING JOINED (proposal 08). Four claims, each about what a phone RENDERS across a
// real reload or reconnect, which is why they need a browser:
//
//   1. A blip at page load is not "not joined". `connect()` read ANY failure of /api/me as a guest, so a phone that
//      reloaded while it was still finding the Wi-Fi landed on "Room code" with no dock and stayed there until a
//      manual reload, and a second join minted "Maya 2". Only a 401 means not joined now: the tab shows its own grey
//      rows, says "Can't reach the party" after 3 s, and lands back where it was when /api/me answers. A captive
//      portal's 200 page counts as unreachable too, not as an answer.
//   2. A cold load of /queue never says "Nothing queued yet" over a queue that has songs in it. `me` arrives before
//      the socket's first `queue:sync`, and the empty state was not gated on the sync.
//   3. None of it shifts the layout: CLS 0 for a guest who never joined, a joined phone, and a blip's recovery.
//   4. A phone whose session is gone is told so. Its socket reconnected as an anonymous spectator: the dot went
//      green, the dock stayed, and every tap was refused with nothing saying why. A reconnect asks /api/me again now,
//      and so does the close the server sends when the session ends from another tab (proposal 20). A 401 is the
//      join screen with "You're not in the room any more" and the old name filled in.
//
// WHY WATCHERS AND NOT POLLS: every defect here is a FLASH or a state the phone moves through, and a poll can step
// over one. An init script's MutationObserver and layout-shift observer see every frame the page ever had.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import type { Page, Route } from '@playwright/test';

/** Queue a song that is NOT ready, so the room has a row that stays put for the whole test. See p19. */
async function singUnprocessed(phone: Page, query: string): Promise<void> {
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(query);
	await phone.locator(SEL.sing).first().click();
}

/** Record, from the first byte of every load, whether the page EVER showed `selector` or `text`. */
async function watchFor(page: Page, text: string, selector = ''): Promise<() => Promise<boolean>> {
	await page.addInitScript(
		([sel, txt]) => {
			const w = window as unknown as { __saw?: boolean };
			w.__saw = false;
			const look = () => {
				if ((sel && document.querySelector(sel)) || document.body?.innerText.includes(txt)) w.__saw = true;
			};
			new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
			document.addEventListener('DOMContentLoaded', look);
		},
		[selector, text] as const
	);
	return () => page.evaluate(() => (window as unknown as { __saw?: boolean }).__saw === true);
}

/** Sum every layout shift from the first byte of every load, with what moved. ONE EXCLUSION: the cooking card's
 *  percentage (`.proc .stage`) reflows sideways when its number gains a digit ("2%" to "20%"), which is the song's
 *  progress arriving, not the page loading, and is the same on main. */
async function watchCls(page: Page): Promise<() => Promise<{ cls: number; moved: string[] }>> {
	await page.addInitScript(() => {
		const w = window as unknown as { __cls: number; __moved: string[] };
		w.__cls = 0;
		w.__moved = [];
		new PerformanceObserver((list) => {
			for (const e of list.getEntries() as unknown as {
				value: number;
				hadRecentInput: boolean;
				startTime: number;
				sources?: { node?: Element; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
			}[]) {
				if (e.hadRecentInput) continue;
				const sources = e.sources ?? [];
				if (sources.length && sources.every((s) => s.node?.closest?.('.proc .stage'))) continue;
				w.__cls += e.value;
				for (const s of sources) {
					const [a, b] = [s.previousRect, s.currentRect];
					w.__moved.push(
						`${Math.round(e.startTime)}ms ${s.node?.nodeName}.${s.node?.className?.toString()} ` +
							`x ${Math.round(a.x)}→${Math.round(b.x)} y ${Math.round(a.y)}→${Math.round(b.y)} ` +
							`h ${Math.round(a.height)}→${Math.round(b.height)}`
					);
				}
			}
		}).observe({ type: 'layout-shift', buffered: true });
	});
	return () =>
		page.evaluate(() => {
			const w = window as unknown as { __cls: number; __moved: string[] };
			return { cls: w.__cls, moved: w.__moved };
		});
}

// The network is gone for /api/me only: the page and its assets still load, as on a phone that reloaded from its cache
// while it rejoined the guest Wi-Fi. A captive portal or a hotel login page answers 200 to every URL, which a phone
// must not read as the room — that wedged it on grey rows for good.
const UNREACHABLE: Record<string, (r: Route) => Promise<void>> = {
	'a network error': (r) => r.abort('internetdisconnected'),
	'a captive portal’s 200 page': (r) =>
		r.fulfill({ status: 200, contentType: 'text/html', body: '<html>Sign in to Hotel Wi-Fi</html>' }),
	'a 200 with no singer': (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"singer":null}' })
};
for (const [what, answer] of Object.entries(UNREACHABLE)) {
	// Every tab for the plain network error; the two 200s on /queue, where the song proves the phone got back in.
	const paths = what === 'a network error' ? ['/queue', '/', '/library'] : ['/queue'];
	test(`a joined phone that reloads into ${what} never sees the join screen, and comes back by itself`, async ({
		world
	}) => {
		const phone = await world.openPhone('P22Blip');
		await singUnprocessed(phone, 'caroline');
		await openQueue(phone);
		await expect(phone.locator(SEL.processing).first()).toBeAttached();

		const sawJoin = await watchFor(phone, 'Room code', SEL.joinColumn);
		const cls = await watchCls(phone);
		for (const path of paths) {
			await phone.route('**/api/me', answer);
			await phone.goto(path);
			await expect(phone.getByText(SEL.unreachable)).toBeVisible({ timeout: 6_000 });
			await expect(phone.getByText("Check you're on the party Wi-Fi.")).toBeVisible();
			// One cue for one state: the page carries the message, so the dock's bar does not say it a second time.
			await expect(phone.getByText('Reconnecting…')).toHaveCount(0);
			await phone.waitForTimeout(5_000 - 3_500);

			await phone.unroute('**/api/me');
			// Back on the tab it opened, with the dock, and nobody tapped anything.
			await expect(phone.locator(SEL.roomPending)).toHaveCount(0, { timeout: 10_000 });
			await expect(phone.locator(SEL.dock).first()).toBeAttached();
			if (path === '/queue') await expect(phone.locator(SEL.processing).first()).toBeAttached();
			if (path === '/') await expect(phone.locator(SEL.findBox).first()).toBeAttached();
			expect(new URL(phone.url()).pathname).toBe(path);
			expect(await sawJoin(), `the join screen showed during the blip on ${path}`).toBe(false);
			await phone.waitForTimeout(1_000);
			const shifts = await cls();
			expect(shifts.cls, `the recovery on ${path} shifted: ${shifts.moved.join(', ')}`).toBe(0);
		}
	});
}

/* CLS 0 FROM THE FIRST BYTE, for the three loads a phone has: a guest who never joined, a joined phone, and a joined
   phone recovering from a blip (above). The first paint waits out PENDING_GRACE_MS or /api/me's answer, so neither a
   joined shell nor a join form is ever painted and then pulled away. */
for (const width of [390, 320]) {
	test(`no layout shift on a cold load at ${width}, joined or not`, async ({ browser, world }) => {
		const ctx = await browser.newContext({ viewport: { width, height: 844 }, baseURL: world.baseURL });
		const guest = await ctx.newPage();
		const guestCls = await watchCls(guest);
		const phone = await world.openPhone(`P22Cls${width}`);
		await phone.setViewportSize({ width, height: 844 });
		await singUnprocessed(phone, 'caroline');
		const phoneCls = await watchCls(phone);
		try {
			for (const path of ['/', `/?room=${world.code}`, '/queue', '/library']) {
				await guest.goto(path);
				await expect(guest.locator(SEL.joinColumn).first()).toBeVisible({ timeout: 10_000 });
				await guest.waitForTimeout(1_000);
				const s = await guestCls();
				expect(s.cls, `never joined, ${path}: ${s.moved.join(', ')}`).toBe(0);
			}
			// A slow 401: past the grace, so the placeholder paints first and the join screen then replaces it.
			await guest.route('**/api/me', (r) => setTimeout(() => void r.continue().catch(() => {}), 600));
			for (const path of ['/', '/queue', '/library']) {
				await guest.goto(path);
				await expect(guest.locator(SEL.joinColumn).first()).toBeVisible({ timeout: 10_000 });
				await guest.waitForTimeout(1_000);
				const s = await guestCls();
				expect(s.cls, `never joined, /api/me 600 ms, ${path}: ${s.moved.join(', ')}`).toBe(0);
			}
			await guest.unroute('**/api/me');
			for (const path of ['/', '/queue', '/library']) {
				await phone.goto(path);
				await expect(phone.locator(SEL.dock).first()).toBeAttached({ timeout: 10_000 });
				await phone.waitForTimeout(1_500);
				const s = await phoneCls();
				expect(s.cls, `joined, ${path}: ${s.moved.join(', ')}`).toBe(0);
			}
		} finally {
			await ctx.close();
		}
	});
}

test('a cold load of /queue never says "Nothing queued yet" over a queue with songs in it', async ({ world }) => {
	const phone = await world.openPhone('P22Cold');
	await singUnprocessed(phone, 'caroline');
	await openQueue(phone);
	await expect(phone.locator(SEL.processing).first()).toBeAttached();

	// The socket's first sync held back, so the window between `me` and the queue is wide enough to see on any box.
	await phone.routeWebSocket(/\/ws/, (ws) => {
		const server = ws.connectToServer();
		const opened = Date.now();
		server.onMessage((m) => {
			const wait = opened + 1_500 - Date.now();
			if (wait > 0) setTimeout(() => ws.send(m), wait);
			else ws.send(m);
		});
		ws.onMessage((m) => server.send(m));
	});
	const sawEmpty = await watchFor(phone, 'Nothing queued yet');
	await phone.goto('/queue');
	await expect(phone.locator(SEL.processing).first()).toBeAttached({ timeout: 10_000 });
	expect(await sawEmpty(), '"Nothing queued yet" showed before the first row').toBe(false);
});

// `/` has a join screen of its own; `/settings` does not, so the phone is taken to `/` to be told.
for (const start of ['/', '/settings']) {
	test(`a phone whose session goes mid-party on ${start} is told so at once, with its name kept`, async ({ world }) => {
		const phone = await world.openPhone('P22Gone');
		await openBrowseFromHome(phone);
		if (start !== '/') await phone.goto(start);
		await expect(phone.locator(SEL.dock).first()).toBeAttached();
		const before = ((await (await phone.request.get('/api/me')).json()) as { singer: { color: string } }).singer.color;
		// Watched from here, in this same document: what each live region held when it first appeared, and every
		// layout shift. A region that first appears with its words already in it is one a screen reader may skip.
		await phone.evaluate(() => {
			const w = window as unknown as {
				__first: Record<string, string>;
				__gap: Record<string, number>;
				__cls: number;
				__moved: string[];
			};
			w.__first = {};
			w.__gap = {};
			w.__moved = [];
			w.__cls = 0;
			// A frame counter, so "filled later" means a later PAINTED frame, not just a later microtask.
			let frame = 0;
			const tick = () => {
				frame++;
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
			const seenAt: Record<string, number> = {};
			// The dock's top edge with its "Reconnecting…" bar up: anything starting there or lower is the dock, even
			// once it has been removed and the entry names no node.
			const dockTop = (document.querySelector('.dock')?.getBoundingClientRect().top ?? innerHeight) - 30;
			const isDock = (s: { node?: Element; previousRect: DOMRectReadOnly }) =>
				s.node?.closest?.('.dock') || (!s.node?.isConnected && s.previousRect.y >= dockTop);
			const look = () => {
				for (const sel of ['.lost', '.cta-reason']) {
					const el = document.querySelector(sel);
					if (!el) continue;
					if (!(sel in w.__first)) {
						w.__first[sel] = el.textContent ?? '';
						seenAt[sel] = frame;
					}
					if (el.textContent && !(sel in w.__gap)) w.__gap[sel] = frame - seenAt[sel]!;
				}
			};
			new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
			new PerformanceObserver((list) => {
				for (const e of list.getEntries() as unknown as {
					value: number;
					hadRecentInput: boolean;
					sources?: { node?: Element; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
				}[]) {
					// The dock's "Reconnecting…" bar comes and goes with the drop this test makes, as it does on main:
					// that is the offline cue doing its job. What is measured is the join screen replacing the page.
					if (e.hadRecentInput || (e.sources?.length && e.sources.every(isDock))) continue;
					w.__cls += e.value;
					for (const s of e.sources ?? [])
						w.__moved.push(
							`${s.node?.nodeName}.${s.node?.className?.toString()} y ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)}`
						);
				}
			}).observe({ type: 'layout-shift' });
		});

		// Leave from another tab: the same cookie jar, so the server ends the session and clears the cookie. The
		// server then closes this page's socket too (proposal 20), and the phone asks /api/me at once. Before #996 the
		// socket came back as a spectator instead: green, dock up, every tap refused.
		expect((await phone.context().request.post('/api/leave')).status()).toBe(200);
		await expect(phone.getByText("You're not in the room any more. Join again to sing.")).toBeVisible({
			timeout: 15_000
		});
		await expect(phone.locator(SEL.joinColumn).first()).toBeVisible();
		expect(new URL(phone.url()).pathname).toBe('/');
		expect(await phone.locator(SEL.dock).count(), 'the dock outlived the session').toBe(0);
		const seen = await phone.evaluate(() => {
			const w = window as unknown as {
				__first: Record<string, string>;
				__gap: Record<string, number>;
				__cls: number;
				__moved: string[];
			};
			return { __first: w.__first, __gap: w.__gap, __cls: w.__cls, __moved: w.__moved };
		});
		expect(seen.__first['.lost'], "the lost line's region appeared already filled").toBe('');
		expect(seen.__first['.cta-reason'], "the code step's reason region appeared already filled").toBe('');
		// Two frames: filled in the frame after the first, the empty region was never painted (one frame is not enough).
		expect(seen.__gap['.lost'], 'the lost line was filled before its empty region was painted').toBeGreaterThanOrEqual(
			2
		);
		expect(
			seen.__gap['.cta-reason'],
			'the reason was filled before its empty region was painted'
		).toBeGreaterThanOrEqual(2);
		if (start === '/')
			expect(seen.__cls, `the join screen shifted the page it replaced: ${seen.__moved.join(', ')}`).toBe(0);

		// The name is kept for the identity pane, one code away.
		await phone.locator('.code-entry input').first().click();
		await phone.keyboard.type(world.code);
		await expect(phone.locator(SEL.nameInput)).toHaveValue('P22Gone', { timeout: 10_000 });

		// And the colour: joining again sends the one they had, so their songs on the TV keep it.
		const join = phone.waitForRequest('**/api/join');
		await phone.getByRole('button', { name: SEL.submit }).click();
		expect((JSON.parse((await join).postData() ?? '{}') as { color?: string }).color).toBe(before);
		await expect(phone.locator(SEL.dock).first()).toBeAttached({ timeout: 15_000 });
		const after = ((await (await phone.request.get('/api/me')).json()) as { singer: { color: string } }).singer.color;
		expect(after, 'joined again in another colour').toBe(before);
	});
}
