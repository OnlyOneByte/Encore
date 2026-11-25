// Proposal 29 PR 4: the host taps "Show the night" and the TV plays the room's night in slides. What the room saw,
// never a ranking, and never a singer who said "Don't keep my nights". Frames at 1920 and 1280, a filmstrip for the GIF,
// the type floor, and tap to first slide <= 300 ms. See docs/FRONTEND.md#tonight-on-the-tv.
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { queueReady, transportTap } from '../../world/actors';
import { serverPlayback } from './audio-probe-support';
import type { Page, TestInfo } from '@playwright/test';
import type { World } from '../../world/fixtures';

test.setTimeout(240_000);

async function ready(world: World, phone: Page, query: string): Promise<void> {
	const track = await world.awaitDemoTrack(query);
	expect((await phone.request.post('/api/process', { data: { mediaId: track.id } })).ok()).toBe(true);
	await expect
		.poll(
			async () => {
				const body = (await phone.request.get('/api/library').then((r) => r.json())) as {
					library: { id: string; instrumentalRef?: string | null }[];
				};
				return body.library.some((m) => m.id === track.id && !!m.instrumentalRef);
			},
			{ timeout: 60_000, message: `"${track.title}" never reached ready` }
		)
		.toBe(true);
}

/** The demo files are named like `sweet-caroline`; the frames show a song's real title. */
async function retitle(world: World, host: Page, query: string, title: string, artist: string) {
	const track = await world.awaitDemoTrack(query);
	const res = await host.request.post('/api/library/manage/rename', { data: { mediaId: track.id, title, artist } });
	expect(res.status(), `rename "${query}"`).toBe(200);
}

const current = async (world: World) => (await serverPlayback(world.baseURL)).state.currentEntryId;

const cheer = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(`ws://${location.host}/ws`);
				ws.onopen = () => {
					ws.send(JSON.stringify({ type: 'room:react', kind: 'clap' }));
					setTimeout(() => (ws.close(), resolve()), 200);
				};
				ws.onerror = () => reject(new Error('raw socket failed'));
			})
	);

/** One turn, start to skip, with `cheers` claps from `fan` while it plays. */
async function turn(world: World, singer: Page, query: string, fan?: Page, cheers = 0) {
	await queueReady(singer, query);
	await expect.poll(() => current(world), { timeout: 30_000 }).not.toBeNull();
	for (let i = 0; i < cheers; i++) await cheer(fan!);
	await transportTap(singer, 'skip');
	await expect.poll(() => current(world), { timeout: 15_000 }).toBeNull();
}

async function settled(page: Page) {
	await page.waitForFunction(() =>
		document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)
	);
}

/** Every text box in the slide: at least the 20 px floor, and inside the safe area. */
async function typeAndSafeArea(tv: Page) {
	return tv.evaluate(() => {
		const root = document.querySelector('[data-testid="tv-tonight"]')!;
		const css = getComputedStyle(document.documentElement);
		const px = (v: string) => {
			const probe = document.createElement('div');
			probe.style.cssText = `position:absolute;width:${v}`;
			document.body.appendChild(probe);
			const w = probe.getBoundingClientRect().width;
			probe.remove();
			return w;
		};
		const sx = px(css.getPropertyValue('--tv-safe-x'));
		const sy = px(css.getPropertyValue('--tv-safe-y'));
		const bad: string[] = [];
		let smallest = Infinity;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (!n.textContent?.trim()) continue;
			const el = n.parentElement!;
			smallest = Math.min(smallest, parseFloat(getComputedStyle(el).fontSize));
			const range = document.createRange();
			range.selectNodeContents(n);
			const b = range.getBoundingClientRect();
			if (b.left < sx - 1 || b.top < sy - 1 || b.right > innerWidth - sx + 1 || b.bottom > innerHeight - sy + 1)
				bad.push(
					`${n.textContent.trim()} @ ${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.right)},${Math.round(b.bottom)}`
				);
		}
		return { smallest, bad };
	});
}

/** Frames of the slide on screen at 1920 and 1280, with its type and safe area checked at both. */
async function frames(tv: Page, testInfo: TestInfo, name: string) {
	for (const [w, h] of [
		[1920, 1080],
		[1280, 720]
	] as const) {
		await tv.setViewportSize({ width: w, height: h });
		await settled(tv);
		const { smallest, bad } = await typeAndSafeArea(tv);
		expect(smallest, `${name} at ${w}: text under the 20 px floor`).toBeGreaterThanOrEqual(20);
		expect(bad, `${name} at ${w}: text outside the safe area`).toEqual([]);
		await tv.screenshot({ path: testInfo.outputPath(`${name}-${w}.png`) });
	}
	await tv.setViewportSize({ width: 1920, height: 1080 });
}

async function showNight(host: Page, tv: Page): Promise<number> {
	await tv.evaluate(() => {
		const w = window as unknown as { tonightAt?: number };
		delete w.tonightAt;
		new MutationObserver((_, obs) => {
			if (document.querySelector('[data-testid="tv-tonight"]')) {
				w.tonightAt = Date.now();
				obs.disconnect();
			}
		}).observe(document.body, { childList: true, subtree: true });
	});
	await host.goto('/queue');
	const button = host.getByTestId('show-night');
	await expect(button).toBeVisible();
	const tappedAt = Date.now();
	await button.click();
	await expect(tv.getByTestId('tv-tonight')).toBeVisible();
	const at = await tv.evaluate(() => (window as unknown as { tonightAt?: number }).tonightAt ?? 0);
	return at - tappedAt;
}

test('the host shows the night: totals, the first song, who sang and the last song, then back to the lobby', async ({
	world
}, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		const maya = await world.openPhone('Maya');
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await ready(world, theo, 'caroline');
		await ready(world, maya, 'believin');
		await retitle(world, host, 'caroline', 'Sweet Caroline', 'Neil Diamond');
		await retitle(world, host, 'believin', "Don't Stop Believin'", 'Journey');
		const tv = await world.openTv();
		await turn(world, theo, 'caroline', maya, 3);
		await turn(world, maya, 'believin', theo, 2);

		// A guest has no "Show the night", and the server refuses one anyway.
		await maya.goto('/queue');
		await expect(maya.getByTestId('show-night')).toHaveCount(0);
		expect((await maya.request.post('/api/host/tonight')).status()).toBe(403);

		await expect(tv.locator('.lobby')).toBeVisible();
		// The host's Queue tab, with nothing on: "Show the night" under the empty state, at 390 and 320.
		await host.goto('/queue');
		const button = host.getByTestId('show-night');
		await expect(button).toBeVisible();
		for (const [w, h] of [
			[390, 844],
			[320, 568]
		] as const) {
			await host.setViewportSize({ width: w, height: h });
			await button.scrollIntoViewIfNeeded();
			const box = (await button.boundingBox())!;
			expect(box.height, 'Show the night is a 44 px target').toBeGreaterThanOrEqual(44);
			await settled(host);
			await host.screenshot({ path: testInfo.outputPath(`queue-show-night-${w}.png`) });
		}
		await host.setViewportSize({ width: 390, height: 844 });
		const tapToSlideMs = await showNight(host, tv);
		testInfo.annotations.push({ type: 'tap to first slide', description: `${tapToSlideMs} ms` });
		console.log(`tap to first slide: ${tapToSlideMs} ms (budget 300)`);
		expect(tapToSlideMs, 'tap to first slide').toBeLessThanOrEqual(300);
		await expect(host.getByText('The night is on the TV')).toBeVisible();

		const slide = tv.getByTestId('tv-tonight');
		const texts: string[] = [];
		await expect(slide).toHaveAttribute('data-slide', 'totals');
		await expect(tv.getByTestId('tonight-totals').locator('li')).toHaveText(['2 songs', '2 singers', '5 cheers']);
		await expect(slide.locator('header i')).toHaveCount(4);
		texts.push(await slide.innerText());
		await frames(tv, testInfo, 'tonight-totals');

		// The filmstrip for the GIF: the end of the totals slide, then the change to the first song.
		let i = 0;
		let on = true;
		const film = (async () => {
			while (on) await tv.screenshot({ path: testInfo.outputPath(`tonight-${String(i++).padStart(3, '0')}.png`) });
		})();
		await expect(slide).toHaveAttribute('data-slide', 'song', { timeout: 8_000 });
		await tv.waitForTimeout(900);
		on = false;
		await film;
		await expect(tv.getByTestId('tonight-song')).toContainText('First song');
		await expect(tv.getByTestId('tonight-song')).toContainText('Theo');
		await expect(tv.getByTestId('tonight-song')).toContainText('Sweet Caroline');
		texts.push(await slide.innerText());
		await frames(tv, testInfo, 'tonight-first');

		await expect(slide).toHaveAttribute('data-slide', 'everyone', { timeout: 8_000 });
		await expect(tv.getByTestId('tonight-everyone').locator('li')).toHaveText(['Theo', 'Maya']);
		texts.push(await slide.innerText());
		await frames(tv, testInfo, 'tonight-everyone');

		await expect(slide).toHaveAttribute('data-slide', 'song', { timeout: 8_000 });
		await expect(tv.getByTestId('tonight-song')).toContainText('Last song');
		await expect(tv.getByTestId('tonight-song')).toContainText('Maya');
		await expect(tv.getByTestId('tonight-song')).toContainText("Don't Stop Believin'");
		texts.push(await slide.innerText());
		await frames(tv, testInfo, 'tonight-last');

		// Nothing on any slide ranks anyone.
		for (const t of texts) expect(t).not.toMatch(/song of the night|most cheered|loudest|\b(1st|2nd|top)\b/i);

		// Then the lobby again, by itself.
		await expect(tv.locator('.lobby')).toBeVisible({ timeout: 8_000 });
		await expect(slide).toHaveCount(0);
	} finally {
		await worker.stop();
	}
});

test('with a singer who said "Don\'t keep my nights", the TV counts songs only and never names, colours or counts her', async ({
	world
}, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		expect((await ana.request.patch('/api/me/nights', { data: { recording: false } })).ok()).toBe(true);
		await ready(world, theo, 'caroline');
		await ready(world, ana, 'prayer');
		await retitle(world, host, 'caroline', 'Sweet Caroline', 'Neil Diamond');
		await retitle(world, host, 'prayer', 'Livin on a Prayer', 'Bon Jovi');
		const tv = await world.openTv();
		await turn(world, ana, 'prayer', theo, 4);
		await turn(world, theo, 'caroline', ana, 1);
		const colourOf = (p: Page) =>
			p.evaluate(async () => ((await (await fetch('/api/me')).json()) as { singer: { color: string } }).singer.color);
		const [anaColor, theoColor] = [await colourOf(ana), await colourOf(theo)];

		// The frame the TV is sent, read off its socket, so a name or colour the slides never draw is caught too.
		const frames_: string[] = [];
		tv.on('websocket', (ws) =>
			ws.on('framereceived', (f) => {
				if (typeof f.payload === 'string' && f.payload.includes('"tv:tonight"')) frames_.push(f.payload);
			})
		);
		await tv.reload();
		await expect(tv.locator('.lobby')).toBeVisible();
		await showNight(host, tv);

		const slide = tv.getByTestId('tv-tonight');
		const texts: string[] = [];
		// Every colour the slide paints, as the engine computes it (`rgb(...)`), never the markup's spelling.
		const colours = new Set<string>();
		const read = async () => {
			texts.push(await slide.innerText());
			for (const c of await slide.evaluate((root) =>
				[root, ...root.querySelectorAll('*')].flatMap((el) => {
					const s = getComputedStyle(el);
					return [s.color, s.backgroundColor];
				})
			))
				colours.add(c);
		};
		const rgb = (hex: string) => {
			const n = parseInt(hex.replace('#', ''), 16);
			return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
		};
		await expect(tv.getByTestId('tonight-totals').locator('li')).toHaveText(['2 songs']);
		await frames(tv, testInfo, 'tonight-opted-out-totals');
		await read();
		// Ana opened the night, so there is no "first song" slide; who sang is Theo alone, and Theo closed it.
		await expect(slide).toHaveAttribute('data-slide', 'everyone', { timeout: 8_000 });
		await expect(tv.getByTestId('tonight-everyone').locator('li')).toHaveText(['Theo']);
		await read();
		await expect(slide).toHaveAttribute('data-slide', 'song', { timeout: 8_000 });
		await expect(tv.getByTestId('tonight-song')).toContainText('Last song');
		await read();
		await expect(slide.locator('header i')).toHaveCount(3);
		for (const t of texts) expect(t).not.toContain('Ana');
		// The checks can fail: Theo, who is shown, is found by both.
		expect(colours, "the colour check finds a shown singer's colour").toContain(rgb(theoColor));
		expect(colours, "Ana's colour is painted").not.toContain(rgb(anaColor));
		expect(frames_).toHaveLength(1);
		expect(frames_[0], 'the frame names a shown singer').toContain('Theo');
		expect(frames_[0]!.toLowerCase(), "the frame carries a shown singer's colour").toContain(theoColor.toLowerCase());
		expect(frames_[0], 'the frame names Ana').not.toContain('Ana');
		expect(frames_[0], "the frame names Ana's song").not.toContain('Livin on a Prayer');
		expect(frames_[0]!.toLowerCase(), "the frame carries Ana's colour").not.toContain(anaColor.toLowerCase());
	} finally {
		await worker.stop();
	}
});
