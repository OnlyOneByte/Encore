// P21 — NO DEAD ENDS. A turn whose karaoke can never be made must read the same on every screen within seconds:
// the TV lobby, the singer's /queue card, and the strip on every phone. Two ways to get there, one test each:
// a worker that fails the stems job, and no worker at all (the server marks the job unservable on first sight).
//
// THE SERVER'S FRAME STARTS THE CLOCK. Each test waits for the terminal or unservable `media:status` off its own
// socket, then gives the screens 5s to agree. Before the /api/process ordering fix, the no-worker case drew
// "Making karaoke… 0%" for the whole 120s TTL on a job the server had already given up on.
//
// `NDE_SHOTS=<dir>` writes the TV, the singer's /queue and the other phone's home as PNGs, pass or fail, which is
// how the before/after evidence for this change was taken.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import { stripReadsWhole } from '../gate/strip-measure';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { Page } from '@playwright/test';

const AGREE_MS = 5_000;

/** Resolves on the first `media:status` that `done` accepts. The test processes one song, so any media will do. */
async function awaitStatus(
	baseURL: string,
	done: (f: { status: string; unservable?: boolean }) => boolean
): Promise<{ wait: Promise<void>; close: () => void }> {
	const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=phone`);
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', (err) => reject(err));
	});
	const wait = new Promise<void>((resolve) => {
		ws.on('message', (raw: Buffer | string) => {
			const m = JSON.parse(String(raw)) as { type?: string; mediaId?: string; status?: string; unservable?: boolean };
			if (m.type === 'media:status' && done({ status: String(m.status), unservable: m.unservable })) resolve();
		});
	});
	return { wait, close: () => ws.close() };
}

/** A YouTube hit, as in the replay that found this: the box has no ffmpeg to index the seeded library with. */
async function sing(phone: Page, query: string): Promise<void> {
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(query);
	await phone
		.locator(SEL.songRow)
		.filter({ hasText: /caroline/i })
		.locator(SEL.singAction)
		.first()
		.click();
}

async function shoot(label: string, pages: Record<string, Page>): Promise<void> {
	const dir = process.env.NDE_SHOTS;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	for (const [name, page] of Object.entries(pages)) await page.screenshot({ path: join(dir, `${label}-${name}.png`) });
}

/** The three screens a guest can look at, read together so a failure prints all of them. */
async function screens(tv: Page, maya: Page, theo: Page) {
	const text = async (p: Page, sel: string) =>
		(
			await p
				.locator(sel)
				.first()
				.textContent({ timeout: 1_000 })
				.catch(() => null)
		)?.trim() ?? '';
	return {
		tv: await text(tv, `${SEL.lobby} h1`),
		mayaStrip: await text(maya, SEL.npStripStatus),
		theoStrip: await text(theo, SEL.npStripStatus),
		mayaCard: await text(maya, SEL.processing)
	};
}

for (const scenario of ['failing stems', 'no worker'] as const) {
	test(`a turn nobody can make reads the same on the TV, the card and the strip (${scenario})`, async ({ world }) => {
		// `fetch:ytdlp` is what a YouTube source routes as; the fake fetch writes a tone, then stems fails.
		const worker =
			scenario === 'failing stems'
				? await startFakeWorker(world, { fail: 'stems', slowMs: 150, capabilities: ['fetch:ytdlp', 'stems', 'align'] })
				: null;
		try {
			const tv = await world.openTv();
			const maya = await world.openPhone('Maya');
			const theo = await world.openPhone('Theo');
			const watch = await awaitStatus(world.baseURL, (f) =>
				scenario === 'failing stems' ? f.status === 'failed' : f.unservable === true
			);
			try {
				await sing(maya, 'sweet caroline');
				await watch.wait;
				if (scenario === 'no worker') {
					// The search row the guest just tapped tells the same truth, not "Making karaoke… 0%".
					const row = maya
						.locator(SEL.songRow)
						.filter({ hasText: /caroline/i })
						.first();
					await expect(row).toContainText("Can't make this one right now", { timeout: AGREE_MS });
					await expect(row).not.toContainText('Making karaoke');
					// And no progress bar: a bar near 0 reads as slow, not stopped.
					await expect(row.locator('[aria-label="Process progress"]')).toHaveCount(0);
				}
				await openQueue(maya);
				const label = scenario === 'failing stems' ? 'failed' : 'no-worker';
				const expected =
					scenario === 'failing stems'
						? {
								tv: "Maya's song didn't work",
								mayaStrip: "Your song didn't work. Try again or pick another.",
								theoStrip: "Maya's song didn't work",
								mayaCard: expect.stringContaining("Couldn't make karaoke")
							}
						: {
								tv: "Can't make new karaoke right now",
								mayaStrip: "Can't make new karaoke right now",
								theoStrip: "Can't make new karaoke right now",
								mayaCard: expect.stringContaining("Can't make this one right now")
							};
				try {
					await expect
						.poll(() => screens(tv, maya, theo), { timeout: AGREE_MS, message: `screens disagree (${scenario})` })
						.toEqual(expected);
					// The singer's own strip carries the longest line, both ways out, and on Sing and Library it is her only
					// notice: the whole sentence shows at the narrowest phone and the common one.
					for (const width of [320, 390]) {
						await maya.setViewportSize({ width, height: 844 });
						await stripReadsWhole(maya, `Maya's strip at ${width}px (${scenario})`);
					}
					await maya.setViewportSize({ width: 390, height: 844 });
					// The way forward is on the card, which is what the "try again" toast points at.
					const retry = maya.locator(`${SEL.processing} [data-testid="card-retry"]`);
					await expect(retry).toBeVisible();
					if (scenario === 'no worker') {
						// Try again inside the 120s window reuses the job the sweep has already seen and will not
						// re-announce, so the route's own frame must keep the verdict or every screen says "Making karaoke…".
						await retry.click();
						await maya.waitForTimeout(2_000);
						await expect
							.poll(() => screens(tv, maya, theo), { timeout: AGREE_MS, message: 'Try again cleared the verdict' })
							.toEqual(expected);
						// A phone and a TV that load INSIDE the window: the sweep will not say it again, so they learn it
						// from /api/library's seed or draw "Making karaoke…" and "this takes a minute".
						await Promise.all([theo.reload(), tv.reload()]);
						await expect
							.poll(() => screens(tv, maya, theo), { timeout: AGREE_MS, message: 'a reload lost the verdict' })
							.toEqual(expected);
					}
				} finally {
					await shoot(label, { tv, 'maya-queue': maya, 'theo-home': theo });
				}
			} finally {
				watch.close();
			}
		} finally {
			await worker?.stop();
		}
	});
}

/** Every screen a guest can be looking at, whole-page, for the three lines a no-maker room must never print. */
async function untruths(pages: Record<string, Page>): Promise<Record<string, string[]>> {
	const out: Record<string, string[]> = {};
	for (const [name, p] of Object.entries(pages)) {
		const text = (await p.locator('body').innerText()).toLowerCase();
		const hits = ['making karaoke', 'takes a minute', "we'll make"].filter((s) => text.includes(s));
		if (hits.length) out[name] = hits;
	}
	return out;
}

test('past the TTL, a reload and a Try-again-then-reload still say "no maker" on every screen', async ({ world }) => {
	// The TTL is the server's real 120s, so this is the one slow scenario: the failure it tests only exists after it.
	test.setTimeout(300_000);
	const tv = await world.openTv();
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	const failed = await awaitStatus(world.baseURL, (f) => f.status === 'failed');
	try {
		await sing(maya, 'sweet caroline');
		await failed.wait;
	} finally {
		failed.close();
	}
	const noMaker = "Can't make new karaoke right now";
	const agree = async (why: string) =>
		expect
			.poll(
				async () => ({
					tv: await tv.locator(`${SEL.lobby} h1`).first().textContent(),
					maya: await maya.locator(SEL.npStripStatus).first().textContent(),
					theo: await theo.locator(SEL.npStripStatus).first().textContent()
				}),
				{ timeout: AGREE_MS, message: why }
			)
			.toEqual({ tv: noMaker, maya: noMaker, theo: noMaker });

	// 1. The TTL has killed the job. The TV and Theo load NOW: only the server's library row knows why it died.
	await Promise.all([theo.reload(), tv.reload()]);
	await agree('a reload after the TTL lost the no-maker cause');

	// 2. Try again opens a NEW unservable window; then everyone reloads — Maya on top of her 30-minute scar.
	await openQueue(maya);
	const again = await awaitStatus(world.baseURL, (f) => f.unservable === true);
	try {
		await maya.locator(`${SEL.processing} [data-testid="card-retry"]`).click();
		await again.wait;
	} finally {
		again.close();
	}
	await Promise.all([maya.reload(), theo.reload(), tv.reload()]);
	await agree('a reload inside the post-TTL window brought back a stale screen');
	// Theo's Sing tab, searching the dead song: the group heading over it must not claim it is being made.
	await openBrowseFromHome(theo);
	await theo.locator(SEL.search).fill('sweet caroline');
	await theo
		.locator(SEL.songRow)
		.filter({ hasText: /caroline/i })
		.first()
		.waitFor();
	await expect.poll(() => untruths({ tv, maya, theo }), { timeout: AGREE_MS }).toEqual({});
	await shoot('post-ttl', { tv, 'maya-queue': maya, 'theo-sing': theo });
});

test('past the TTL, a maker joining ends "no maker" on every screen, live and after a reload', async ({ world }) => {
	test.setTimeout(300_000);
	const tv = await world.openTv();
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	const failed = await awaitStatus(world.baseURL, (f) => f.status === 'failed');
	try {
		await sing(maya, 'sweet caroline');
		await failed.wait;
	} finally {
		failed.close();
	}
	await openQueue(maya);
	// The room now CAN make karaoke: the song is a plain failure that a Try again fixes, not a room with no maker.
	const plain = {
		tv: "Maya's song didn't work",
		mayaStrip: "Your song didn't work. Try again or pick another.",
		theoStrip: "Maya's song didn't work",
		mayaCard: expect.stringContaining("Couldn't make karaoke")
	};
	// Every screen names the way out the card offers: the TV's second line and the card's own button.
	const allAgree = async (why: string) => {
		await expect.poll(() => screens(tv, maya, theo), { timeout: AGREE_MS, message: why }).toEqual(plain);
		await expect(tv.locator(SEL.lobby)).toContainText('Maya, try again or pick another on your phone');
		await expect(maya.locator(`${SEL.processing} [data-testid="card-retry"]`).first()).toBeVisible();
	};
	const worker = await startFakeWorker(world, { slowMs: 150, capabilities: ['fetch:ytdlp', 'stems', 'align'] });
	let stopped = false;
	try {
		await allAgree('a maker joined and the room still says none');
		await Promise.all([maya.reload(), theo.reload(), tv.reload()]);
		await allAgree('a reload brought "no maker" back');
		await shoot('maker-joined', { tv, 'maya-queue': maya, 'theo-home': theo });
		// The maker LEAVES: live screens say "no maker" again with no reload, as a reload would.
		await worker.stop();
		stopped = true;
		await expect
			.poll(() => screens(tv, maya, theo), {
				timeout: AGREE_MS,
				message: 'the maker left and live screens did not say so'
			})
			.toEqual({
				tv: "Can't make new karaoke right now",
				mayaStrip: "Can't make new karaoke right now",
				theoStrip: "Can't make new karaoke right now",
				// The card is the song's own record, as after the TTL: it died, and the strips say why nothing follows.
				mayaCard: expect.stringContaining("Couldn't make karaoke")
			});
		await shoot('maker-left', { tv, 'maya-queue': maya, 'theo-home': theo });
	} finally {
		if (!stopped) await worker.stop();
	}
});

// A file-backed DB, so the restarted core boots the same room, queue and job rows.
test.describe(() => {
	test.use({ coreEnv: { ENCORE_EPHEMERAL: '0' } });

	test('a core restart mid-making, with no worker after it: live screens read what a reload reads', async ({
		world
	}) => {
		test.setTimeout(180_000);
		const tv = await world.openTv();
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		// A worker that takes the song to a making stage and then sits there.
		const worker = await startFakeWorker(world, { slowMs: 60_000, capabilities: ['fetch:ytdlp', 'stems', 'align'] });
		try {
			await sing(maya, 'sweet caroline');
			await openQueue(maya);
			await expect(maya.locator(SEL.processing).first()).toContainText('%', { timeout: AGREE_MS });
		} finally {
			await worker.stop();
		}
		// The host reboots: core comes back on the same port and DB, and no worker does. Its boot sweep says
		// "unservable" once, before any phone or the TV has reconnected; only their re-read can learn it.
		await world.core.restart();
		const stall = {
			tv: "Can't make new karaoke right now",
			mayaStrip: "Can't make new karaoke right now",
			theoStrip: "Can't make new karaoke right now",
			mayaCard: expect.stringContaining("Can't make this one right now")
		};
		await expect
			.poll(() => screens(tv, maya, theo), {
				timeout: 20_000,
				message: 'after the restart, live screens kept the old word'
			})
			.toEqual(stall);
		await expect(maya.locator(`${SEL.processing} [aria-label="Process progress"]`)).toHaveCount(0);
		await shoot('restart-live', { tv, 'maya-queue': maya, 'theo-home': theo });
		await Promise.all([maya.reload(), theo.reload(), tv.reload()]);
		await expect
			.poll(() => screens(tv, maya, theo), { timeout: AGREE_MS, message: 'a reload after the restart disagrees' })
			.toEqual(stall);
	});
});
