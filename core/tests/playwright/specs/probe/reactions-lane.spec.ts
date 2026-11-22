/*
 * ROOM REACTIONS, end to end on the real core: what the server sends to whom, and where the TV draws it.
 *
 * WIRING (server.ts itself, not a copy): every phone's and the TV's WebSocket frames are recorded. A fan's raw
 * `room:react` must reach the TV as `room:reacted` (the positive control that makes the rest mean something);
 * no phone may ever receive one; the singer's own raw frame, and a fan's after the room switched reactions off,
 * must reach nobody.
 *
 * GEOMETRY: while phones burst, every sample reads what the layout engine resolved. Each disc must lie inside the
 * safe area ([safe-x, vw - safe-x]) and clear of every lyric row, the lyrics' content box, the lower-third, Up
 * next, the corner QR, the fullscreen button and the status dot — at 720p, 1080p and 4K, and at the largest
 * lyric scale. No two discs may touch, and the on-screen bound is the release spacing's, ceil(2400 / 650) = 4.
 */
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { burst, countMounts, mounted, putRoom, stage } from '../../world/reactions';
import { MAX_LYRICS_SCALE_PCT } from '$lib/contract';
import { TAP } from '../gate/measured-design-register';
import type { Page } from '@playwright/test';

const SAMPLE_MS = 80;
const SAMPLE_WINDOW_MS = 4_500;
/** ceil(RISE_MS / SPACING_MS) in tv/Reactions.svelte: the most discs the release spacing ever has on screen. */
const ON_SCREEN_BOUND = 4;
/** MAX_WAITING in tv/Reactions.svelte. */
const MAX_WAITING = 6;
/** Long enough for any frame the server sends to have arrived. */
const SETTLE_MS = 1_500;

interface Box {
	l: number;
	t: number;
	r: number;
	b: number;
}
interface Sample {
	discs: Box[];
	chrome: { cls: string; box: Box }[];
	safeX: number;
	vw: number;
}

/** A raw `room:react` on a NEW socket from this page, so it carries the page's own session cookie. */
async function rawReact(page: Page, kind = 'clap'): Promise<void> {
	await page.evaluate(
		(kind) =>
			new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
				ws.onopen = () => {
					ws.send(JSON.stringify({ type: 'room:react', kind }));
					setTimeout(() => (ws.close(), resolve()), 200);
				};
				ws.onerror = () => reject(new Error('raw socket failed'));
			}),
		kind
	);
}

/** Every disc and every box it must stay clear of, in one round trip so they describe one frame. */
async function sample(tv: Page): Promise<Sample> {
	return tv.evaluate(
		(sel) => {
			const box = (r: DOMRect) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
			// The safe-area inset as the engine resolves it: the token is a max() of env() and viewport terms.
			const probe = document.createElement('div');
			probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--tv-safe-x)';
			document.querySelector(sel.tv)!.appendChild(probe);
			const safeX = probe.getBoundingClientRect().width;
			probe.remove();
			const chrome: { cls: string; box: Box }[] = [];
			for (const [cls, q] of Object.entries(sel.chrome))
				for (const el of document.querySelectorAll(q)) {
					const r = el.getBoundingClientRect();
					if (r.height > 0) chrome.push({ cls, box: box(r) });
				}
			// The reel's CONTENT box: where any row, however long, can paint. The padding is the reserve.
			const lyrics = document.querySelector(sel.lyrics);
			if (lyrics) {
				const r = lyrics.getBoundingClientRect();
				const cs = getComputedStyle(lyrics);
				chrome.push({
					cls: 'lyricsContent',
					box: {
						l: r.left + parseFloat(cs.paddingLeft),
						t: r.top,
						r: r.right - parseFloat(cs.paddingRight),
						b: r.bottom
					}
				});
			}
			return {
				discs: [...document.querySelectorAll(sel.disc)].map((d) => box(d.getBoundingClientRect())),
				chrome,
				safeX,
				vw: window.innerWidth
			};
		},
		{
			tv: SEL.tvRoot,
			disc: SEL.tvReaction,
			lyrics: SEL.lyrics,
			chrome: {
				lyric: SEL.lyricsRow,
				lowerThird: SEL.lowerThird,
				upnext: '.upnext',
				corner: '.corner',
				copyChip: '.copy-slot',
				fullscreen: '.fs-btn',
				status: '.status'
			}
		}
	);
}

async function sampleWindow(tv: Page, ms: number): Promise<Sample[]> {
	const samples: Sample[] = [];
	const until = Date.now() + ms;
	while (Date.now() < until) {
		samples.push(await sample(tv));
		await tv.waitForTimeout(SAMPLE_MS);
	}
	return samples;
}

const overlap = (a: Box, b: Box) =>
	Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
const peakOf = (samples: Sample[]) => Math.max(...samples.map((s) => s.discs.length));

test('the server sends a reaction to the TV only, and refuses the singer and a room that turned them off', async ({
	world
}) => {
	const { worker, star, fans, tv, frames } = await stage(world, 1);
	try {
		// Positive control: a fan's REAL taps — the Cheer key, then one reaction — send exactly one room:react, and it
		// reaches the TV. Pointer clicks, so Playwright's actionability check refuses a button hit-testing cannot reach.
		const fan = fans[0];
		await fan.locator(SEL.npCheerKey).click({ timeout: 5_000 });
		await expect(fan.locator(SEL.npCheer)).toHaveCount(4);
		// Focus follows the tap into the tray: the key that had it is gone.
		await expect(fan.locator(SEL.npCheer).first()).toBeFocused();
		await expect(fan.locator(SEL.npTransport), 'the tray takes the transport’s place').toHaveCount(0);
		// Every key in the tray clears the 44 px tap floor, at 320 too. measured-hit-extents sweeps an idle room only.
		// The layout box (offset*), not the rect: the tray's rise-in scale is still settling at this point.
		for (const width of [390, 320]) {
			await fan.setViewportSize({ width, height: 844 });
			for (const key of await fan.locator(`${SEL.npCheer}, ${SEL.npCheersClose}`).all()) {
				const side = await key.evaluate((e) =>
					Math.min((e as HTMLElement).offsetWidth, (e as HTMLElement).offsetHeight)
				);
				expect(side, `${width}px: a cheer key under the tap floor`).toBeGreaterThanOrEqual(TAP);
			}
		}
		await fan.locator(SEL.npCheer).first().click({ timeout: 5_000 });
		const tapped = Date.now();
		await expect.poll(() => frames.tv.length, { message: 'a fan reaction never reached the TV' }).toBe(1);
		await expect.poll(() => mounted(tv)).toBe(1);

		// The tray gives the strip back 6 s after the LAST tap: still up a second short of that, gone soon after.
		await fan.waitForTimeout(Math.max(0, 5_000 - (Date.now() - tapped)));
		await expect(fan.locator(SEL.npCheers), 'the tray closed before 6 s with no tap').toHaveCount(1);
		await expect(fan.locator(SEL.npCheers)).toHaveCount(0, { timeout: 3_000 });
		await expect(fan.locator(SEL.npTransport)).toHaveCount(3);
		// A tray that closes by itself hands focus back to the key, not to <body>.
		await expect(fan.locator(SEL.npCheerKey), 'focus fell out of the strip when the tray timed out').toBeFocused();
		// ✕ gives it back at once, with focus on the key that opened it.
		await fan.locator(SEL.npCheerKey).click({ timeout: 5_000 });
		await fan.locator(SEL.npCheersClose).click({ timeout: 5_000 });
		await expect(fan.locator(SEL.npCheers)).toHaveCount(0);
		await expect(fan.locator(SEL.npCheerKey)).toBeFocused();

		// The link drops with the tray open: "Reconnecting…" wins the title slot at once, not when the tray's 6 s
		// timer runs out (once measured at 7.46 s), and the key rests, so no tap can be dropped silently.
		await fan.locator(SEL.npCheerKey).click({ timeout: 5_000 });
		await expect(fan.locator(SEL.npCheers)).toHaveCount(1);
		const dropped = Date.now();
		await fan.context().setOffline(true);
		await expect(fan.locator(SEL.npStripOffline)).toBeVisible({ timeout: 4_000 });
		expect(Date.now() - dropped, 'the cue waited for the tray to time out').toBeLessThan(5_000);
		expect(await fan.locator(SEL.npCheers).count(), 'the tray stayed open offline').toBe(0);
		await expect(fan.locator(SEL.npCheerKey)).toHaveAttribute('inert');
		await expect(fan.locator(SEL.npCheerKey)).toHaveCSS('visibility', 'hidden');
		await fan.context().setOffline(false);
		await expect(fan.locator(SEL.npCheerKey)).not.toHaveAttribute('inert', { timeout: 20_000 });

		// The tray CLOSES with the setting, not merely hides: off and straight back on inside the tray's 6 s, and the
		// strip shows the transport again. A one-shot count, not a retrying assertion, which the timer would satisfy.
		await fan.locator(SEL.npCheerKey).click({ timeout: 5_000 });
		await putRoom(star, { tvReactions: false });
		await expect(fan.locator(SEL.npCheerKey)).toHaveAttribute('inert');
		await putRoom(star, { tvReactions: true });
		await expect(fan.locator(SEL.npCheerKey)).not.toHaveAttribute('inert');
		expect(await fan.locator(SEL.npCheers).count(), 'the tray reopened by itself').toBe(0);

		// The singer cheering their own song: refused by the server, not just hidden on the phone. The key rests in
		// its slot so the strip does not shift (dock-cls.spec.ts), with no button left to find or tap.
		await expect(star.locator(SEL.npCheerKey)).toHaveAttribute('inert');
		await expect(star.locator(SEL.npCheerKey)).toHaveCSS('visibility', 'hidden');
		await rawReact(star, 'heart');
		await tv.waitForTimeout(SETTLE_MS);
		expect(frames.tv.length, "the singer's own room:react reached the TV").toBe(1);
		expect(await mounted(tv)).toBe(1);

		// "Reactions on TV" off: the server drops a fan's frame, so the TV's socket hears nothing.
		await fan.locator(SEL.npCheerKey).click({ timeout: 5_000 });
		await expect(fan.locator(SEL.npCheers)).toHaveCount(1);
		await putRoom(star, { tvReactions: false });
		// An open tray closes with the setting, and the key rests in its slot.
		await expect(fan.locator(SEL.npCheers)).toHaveCount(0);
		await expect(fan.locator(SEL.npCheerKey)).toHaveAttribute('inert');
		await tv.waitForTimeout(1_000); // a full bucket again, so only the setting can refuse it
		await rawReact(fans[0], 'clap');
		await tv.waitForTimeout(SETTLE_MS);
		expect(frames.tv.length, 'a reaction reached the TV with "Reactions on TV" off').toBe(1);

		// No phone ever heard one: not the fan who sent them, not the singer.
		expect(frames.fans[0], 'a fan phone received room:reacted').toEqual([]);
		expect(frames.star, "the singer's phone received room:reacted").toEqual([]);
	} finally {
		await worker.stop();
	}
});

test('bursts stay inside the safe area and clear of the lyrics and TV chrome, at 720p, 1080p, 4K and the largest lyric scale', async ({
	world
}) => {
	const { worker, star, fans, tv, frames } = await stage(world, 2);
	try {
		const hits: unknown[] = [];
		const outside: unknown[] = [];
		const touching: unknown[] = [];
		const cases = [
			{ w: 1920, h: 1080, scale: 100 },
			{ w: 1280, h: 720, scale: 100 },
			{ w: 3840, h: 2160, scale: 100 },
			{ w: 1920, h: 1080, scale: MAX_LYRICS_SCALE_PCT }
		];
		for (const c of cases) {
			const label = `${c.w}x${c.h} @${c.scale}%`;
			await putRoom(star, { lyricsScalePct: c.scale });
			await tv.setViewportSize({ width: c.w, height: c.h });
			// Settle the new layout, and refill every bucket from the previous case.
			await tv.waitForTimeout(3_200);
			const before = await mounted(tv);
			await burst(fans);
			const samples = await sampleWindow(tv, SAMPLE_WINDOW_MS);

			expect(peakOf(samples), `${label}: no reaction reached the TV`).toBeGreaterThan(0);
			expect(peakOf(samples), `${label}: more on screen than the release spacing allows`).toBeLessThanOrEqual(
				ON_SCREEN_BOUND
			);
			// 9 taps each inside one tick: the bucket lets 3 through per phone, plus at most one refill each.
			const n = (await mounted(tv)) - before;
			expect(n, `${label}: ${n} discs mounted — the per-singer rate limit did not hold`).toBeLessThanOrEqual(
				2 * (3 + 1)
			);
			expect(
				samples.some((s) => s.chrome.some((ch) => ch.cls === 'lyric')),
				`${label}: no lyric row on screen to measure`
			).toBe(true);
			for (const [i, s] of samples.entries())
				for (const d of s.discs) {
					if (d.l < s.safeX - 0.5 || d.r > s.vw - s.safeX + 0.5)
						outside.push({ label, sample: i, disc: d, safeX: s.safeX });
					for (const ch of s.chrome)
						if (overlap(d, ch.box) > 0) hits.push({ label, sample: i, cls: ch.cls, disc: d, box: ch.box });
				}
			// Disc against disc: the release spacing must keep every pair apart for the whole rise.
			for (const [i, s] of samples.entries())
				for (let a = 0; a < s.discs.length; a++)
					for (let b = a + 1; b < s.discs.length; b++)
						if (overlap(s.discs[a], s.discs[b]) > 0) touching.push({ label, sample: i, a: s.discs[a], b: s.discs[b] });
		}
		expect(outside, 'a reaction disc left the safe area').toEqual([]);
		expect(hits, 'a reaction disc intersected the lyrics or the TV chrome').toEqual([]);
		expect(touching, 'two reaction discs overlapped each other').toEqual([]);
		expect([...frames.fans.flat(), ...frames.star], 'a phone received room:reacted').toEqual([]);
	} finally {
		await worker.stop();
	}
});

test('on a copy TV the lane stands above "Make this the TV", which holds the join card\'s corner', async ({
	world,
	browser
}) => {
	const { worker, fans } = await stage(world, 2);
	// A second screen with no seat cookie: a copy. It hears every room:reacted the real TV does.
	const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: world.baseURL });
	try {
		const copy = await ctx.newPage();
		await copy.goto('/tv');
		await copy.locator(SEL.tvConnected).waitFor({ state: 'attached' });
		await expect(copy.locator('.copy-slot .copy-chip')).toBeVisible({ timeout: 30_000 });
		await expect(copy.locator('.corner'), 'a copy still shows the join card').toHaveCount(0);
		await expect(copy.locator(SEL.lyricsRow).first()).toBeAttached({ timeout: 25_000 });
		await countMounts(copy);
		const hits: unknown[] = [];
		const cases = [
			{ w: 1920, h: 1080, grow: false },
			{ w: 1280, h: 720, grow: false },
			// At its natural size the chip is only a few px shorter than the lower-third, so the band alone happens to
			// clear it. A chip that grows (a wrap, a bigger type step) must lift the lane too: only the measure does that.
			{ w: 1920, h: 1080, grow: true }
		];
		for (const c of cases) {
			const label = `${c.w}x${c.h}${c.grow ? ', a taller chip' : ''}`;
			await copy.setViewportSize({ width: c.w, height: c.h });
			if (c.grow) await copy.addStyleTag({ content: '.copy-chip { min-height: 25vh; }' });
			await copy.waitForTimeout(3_200);
			const [lane, chip] = await copy.evaluate(() =>
				['.reaction-lane', '.copy-slot'].map((q) => document.querySelector(q)!.getBoundingClientRect().toJSON())
			);
			expect(lane.bottom, `${label}: the lane stands on the chip`).toBeLessThanOrEqual(chip.top + 0.5);
			await burst(fans);
			const samples = await sampleWindow(copy, SAMPLE_WINDOW_MS);
			expect(peakOf(samples), `${label}: no reaction reached the copy`).toBeGreaterThan(0);
			expect(
				samples.every((s) => s.chrome.some((ch) => ch.cls === 'copyChip')),
				`${label}: the chip was not on screen to measure`
			).toBe(true);
			for (const [i, s] of samples.entries())
				for (const d of s.discs)
					for (const ch of s.chrome)
						if (overlap(d, ch.box) > 0) hits.push({ label, sample: i, cls: ch.cls, disc: d, box: ch.box });
		}
		expect(hits, 'a reaction disc on the copy intersected the chip, the lyrics or the TV chrome').toEqual([]);

		// A PHONE reading along as a copy: the chip sits top-left, not in the lane's corner, so measuring it can lift the
		// lane at bottom-right by at most the chip's own height above the band it stands on anyway.
		await copy.evaluate(() =>
			document.querySelectorAll('style').forEach((s) => s.textContent?.includes('25vh') && s.remove())
		);
		for (const [w, h] of [
			[390, 844],
			[320, 568]
		]) {
			await copy.setViewportSize({ width: w, height: h });
			await copy.waitForTimeout(1_000);
			const m = await copy.evaluate((sel) => {
				const probe = document.createElement('div');
				probe.style.cssText = 'position:absolute;visibility:hidden;height:var(--tv-chrome-h)';
				document.querySelector(sel)!.appendChild(probe);
				const band = probe.getBoundingClientRect().height;
				probe.remove();
				const lane = document.querySelector('.reaction-lane')!.getBoundingClientRect();
				const chip = document.querySelector('.copy-slot')!.getBoundingClientRect();
				return { band, laneLift: innerHeight - lane.bottom, chipH: chip.height, chipTop: chip.top, laneTop: lane.top };
			}, SEL.tvRoot);
			expect(m.chipTop, `${w}x${h}: the chip is not top-left`).toBeLessThan(m.laneTop);
			expect(m.laneLift, `${w}x${h}: the lane fell below the chrome band`).toBeGreaterThanOrEqual(m.band - 0.5);
			expect(m.laneLift, `${w}x${h}: the lane lifted by more than the chip`).toBeLessThanOrEqual(
				m.band + m.chipH + 0.5
			);
		}
	} finally {
		await ctx.close();
		await worker.stop();
	}
});

test('a room of five bursting at once: the waiting line drops the oldest, the screen stays within its bound', async ({
	world
}) => {
	const { worker, fans, tv } = await stage(world, 5);
	try {
		// 5 x 3 = 15 through the server's buckets; the TV's waiting line holds MAX_WAITING.
		await burst(fans);
		const samples = await sampleWindow(tv, 8_000);
		const n = await mounted(tv);
		expect(peakOf(samples)).toBeLessThanOrEqual(ON_SCREEN_BOUND);
		expect(n, 'the stream should deliver the full waiting line').toBeGreaterThanOrEqual(MAX_WAITING);
		expect(n, 'the oldest waiting reactions should have dropped out').toBeLessThan(15);
	} finally {
		await worker.stop();
	}
});

/** How long the TV's main thread is held right after the first disc mounts: a long frame on a busy TV, well past
 *  the release spacing's slack (Reactions.svelte, SPACING_MS). */
const STALL_MS = 400;

test('a disc whose first frame is late still keeps its distance from the next one', async ({ world }) => {
	const { worker, fans, tv } = await stage(world, 1);
	try {
		// Hold the main thread once, as the first disc mounts and before it can paint: its rise starts STALL_MS late
		// while the wall clock runs on. Nightly 44844250303 caught the same overlap from a slow frame on CI.
		await tv.evaluate(
			({ q, ms }) => {
				const w = window as unknown as { __stalled: number };
				w.__stalled = 0;
				const mo = new MutationObserver((records) => {
					if (!records.some((m) => [...m.addedNodes].some((n) => n instanceof Element && n.matches(q)))) return;
					mo.disconnect();
					const until = performance.now() + ms;
					while (performance.now() < until);
					w.__stalled++;
				});
				mo.observe(document.body, { childList: true, subtree: true });
			},
			{ q: SEL.tvReaction, ms: STALL_MS }
		);
		await burst(fans);
		const samples = await sampleWindow(tv, SAMPLE_WINDOW_MS);
		const stalled = await tv.evaluate(() => (window as unknown as { __stalled: number }).__stalled);
		expect(stalled, 'the stall never ran, so this proves nothing').toBe(1);
		expect(peakOf(samples), 'the burst never put two discs on screen at once').toBeGreaterThanOrEqual(2);
		const touching: unknown[] = [];
		for (const [i, s] of samples.entries())
			for (let a = 0; a < s.discs.length; a++)
				for (let b = a + 1; b < s.discs.length; b++)
					if (overlap(s.discs[a], s.discs[b]) > 0) touching.push({ sample: i, a: s.discs[a], b: s.discs[b] });
		expect(touching, 'two reaction discs overlapped after a late first frame').toEqual([]);
	} finally {
		await worker.stop();
	}
});

test('with reduced motion the stream still releases every disc in turn', async ({ world }) => {
	const { worker, fans, tv } = await stage(world, 1);
	try {
		// The fade, not the rise, starts each disc's spacing here: the line must not stall on the first one.
		await tv.emulateMedia({ reducedMotion: 'reduce' });
		await burst(fans);
		await expect
			.poll(() => mounted(tv), { message: 'the waiting line stalled after the first disc' })
			.toBeGreaterThanOrEqual(3);
	} finally {
		await worker.stop();
	}
});
