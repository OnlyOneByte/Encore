// THE MOTION TABLE — the `shot` project's sibling for things that MOVE. A frame table (frames.spec.ts) proves a
// state at rest; this proves the trip between two states, as a GIF for a human and a ms-labelled filmstrip for
// an agent reviewer. Evidence, not assertions: like every `shot` spec it cannot fail a build on taste, only on
// the capture itself breaking (no motion caught where motion is expected, motion caught where a cut is, or a frame
// after the trigger that does not show the row's `subject`, a `realtime` run that never saw its `each`), and
// on a moving element whose duration, delay or colour is a literal instead of a token (`literalsAllowed` waives
// exactly one named literal, with a reason).
//
// `bun run ui:review` runs it; `-- -g <name>` runs one row. Output: tests/playwright/.artifacts/motion/<name>/,
// or MOTION_OUT/<name>/. What a reviewer checks against it is docs/UI-CHECKLIST.md.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import {
	goOffline,
	openBrowseFromHome,
	openQueue,
	queueReady,
	readySong,
	singOnce,
	transportTap
} from '../../world/actors';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';
import { captureMotion, type MotionScenario } from '../../world/motion';
import { startGallery, type Gallery } from '../../world/gallery';
import type { RealtimeReport } from '../../world/motion-realtime';
import { burst, putRoom, stage } from '../../world/reactions';
import { DEMO_LIBRARY } from '../../world/seed';
import { sendPlayerCommand } from '../probe/audio-probe-support';
import { join } from 'node:path';
import { SETTLE_MS } from '$lib/transport-target';
import { MAX_LYRICS_SCALE_PCT } from '$lib/contract';

/** `cleanup` runs after the capture, pass or fail: a row that starts a fake worker stops it there. */
type Make = (browser: Browser, world: World, cleanup: (fn: () => Promise<unknown>) => void) => MotionScenario;

/** Rows whose honest record today is a CUT: the capture must catch NO animation. Flip a row out of here in the
 *  PR that gives it motion, so the strip it makes is the before/after of that change. */
const CUTS = new Set([
	'spotlight-guide-390',
	'spotlight-guide-320',
	'spotlight-guide-tv',
	'phone-sing-widen-390',
	'phone-sing-widen-320',
	'phone-reorder-held-390',
	'phone-reorder-held-320',
	'phone-cheers-return',
	'phone-dock-idle',
	'tv-copy-claim',
	'tv-copy-offline',
	'tv-copy-offline-390',
	'tv-copy-offline-320',
	'phone-tab-left-390',
	'phone-tab-left-320',
	'phone-tab-adopted-390',
	'phone-tab-adopted-320',
	'phone-keep-me-390',
	'phone-keep-me-320',
	'phone-welcome-back-390',
	'phone-welcome-back-320',
	// Redesign step 5: the card is in the singer's colour from On deck on, so the heads-up changes words, not colour.
	'phone-on-deck-heads-up',
	'phone-heart-save'
]);
/** What a dock CUT row is about: the strip's title and transport. Not the progress hairline, which glides once a
 *  second whenever a song plays (--motion-tick) and is not the change these rows record. */
const STRIP_CONTENT = '.dock .meta, .dock .meta *, .dock .tp, .dock .tp *';

/** A track longer than the 30 s heads-up window, so the on-deck row can cross it. The fixture's own are 8 s. */
const LONG_TRACK = { file: 'long-take.wav', seconds: 36, hz: [196, 246.94, 293.66] };
/** Five runs that each wait out a copy chip's 20 s, inside one song. */
const ROOM_SCREEN_TRACK = { file: 'room-screen-take.wav', seconds: 240, hz: [174.61, 220, 261.63] };
/** Two more songs, so each of the bar row's five pages (seek, three live, reduced) makes a song of its own. */
const BAR_TRACKS = [
	{ file: 'open-road.wav', seconds: 8, hz: [196, 246.94, 293.66] },
	{ file: 'night-drive.wav', seconds: 8, hz: [220, 261.63, 329.63] }
];
/** Long enough that Maya's song is still on for every run of a row that reorders under it. */
const HELD_SECS = 150;
const HELD_LIBRARY = [
	...DEMO_LIBRARY.map((t) => ({ ...t, seconds: HELD_SECS })),
	{ file: 'mr-brightside.wav', seconds: HELD_SECS, hz: [207.65, 261.63, 311.13] }
];
/** Rows that boot their core with more than the demo library. */
const LIBRARY: Record<string, typeof DEMO_LIBRARY> = {
	'phone-on-deck-heads-up': [...DEMO_LIBRARY, LONG_TRACK],
	'phone-processing-bar': [...DEMO_LIBRARY, ...BAR_TRACKS],
	'phone-reorder-held-390': HELD_LIBRARY,
	'phone-reorder-held-320': HELD_LIBRARY,
	'phone-queue-your-song-390': HELD_LIBRARY,
	'phone-queue-your-song-320': HELD_LIBRARY,
	'phone-queue-on-deck-to-up-390': HELD_LIBRARY,
	'phone-queue-on-deck-to-up-320': HELD_LIBRARY,
	'tv-copy-claim': [...DEMO_LIBRARY, LONG_TRACK],
	'tv-copy-chip-wake': [...DEMO_LIBRARY, ROOM_SCREEN_TRACK],
	'tv-copy-chip-sleep': [...DEMO_LIBRARY, ROOM_SCREEN_TRACK],
	'tv-copy-offline': [...DEMO_LIBRARY, LONG_TRACK],
	'tv-copy-offline-390': [...DEMO_LIBRARY, LONG_TRACK],
	'tv-copy-offline-320': [...DEMO_LIBRARY, LONG_TRACK],
	'tv-lyrics-fix': [...DEMO_LIBRARY, LONG_TRACK],
	'tv-chorus-cue': [...DEMO_LIBRARY, ROOM_SCREEN_TRACK]
};

/** How long a fan's reaction bucket takes to refill after a burst (the reaction probe's wait), so every run's burst
 *  sends as many as the first one did. */
const BUCKET_REFILL_MS = 3_200;
/** Rows that boot their core with extra env: a 3 s unservable TTL, so each run taps a song the TTL just killed. */
const CORE_ENV: Record<string, Record<string, string>> = {
	'phone-stalled-retry-after-ttl': { ENCORE_UNSERVABLE_TTL_MS: '3000' }
};
/** What a hold row's page read at each sample (`HOLD_SAMPLES`). */
const HELD_LINE = { at250: 'Trying again…', at1000: 'Trying again…', settled: "Can't make this one right now" };
const HELD: Record<string, typeof HELD_LINE> = {
	'phone-stalled-retry': HELD_LINE,
	'phone-stalled-retry-after-ttl': HELD_LINE
};

let joins = 0;

/** Proposal 20: what one tab shows when ANOTHER tab of the same phone leaves the room (`left`: the join screen, at
 *  once) or joins as someone new (`adopted`: this tab comes back as them). The other tab is the browser's own request
 *  API, so the change reaches this tab the way a tab frozen in the background gets it: the server's close, then the
 *  re-check when the tab comes to the front. Both are cuts: the page swaps, nothing animates. */
function otherTab(kind: 'left' | 'adopted', width: number): Make {
	return (browser, world) => ({
		name: `phone-tab-${kind}-${width}`,
		what:
			kind === 'left'
				? `Phone ${width}: another tab of this phone left the room, so this one shows the join screen with "You're not in the room any more"`
				: `Phone ${width}: another tab joined as someone new, so this one comes back as them (header name changes)`,
		scale: 1,
		columns: 4,
		open: async (opts) => {
			const ctx = await browser.newContext({
				...opts,
				viewport: { width, height: width === 320 ? 568 : 844 },
				baseURL: world.baseURL
			});
			const page = await ctx.newPage();
			await world.joinAs(page, `Maya${++joins}`);
			if (kind === 'adopted') {
				await ctx.request.post('/api/leave');
				await expect(page.getByText("You're not in the room any more. Join again to sing.")).toBeVisible();
			}
			await page.evaluate(() => document.fonts.ready.then(() => true));
			return page;
		},
		trigger: async (page) => {
			const request = page.context().request;
			if (kind === 'left') await request.post('/api/leave');
			else {
				await request.post('/api/join', { data: { displayName: `Theo${++joins}`, code: world.code } });
				// The tab reloads as them, by design: wait for the new page so the capture reads it, not a torn-down one.
				const loaded = page.waitForEvent('load');
				await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
				await loaded;
				await page.locator('.me-name').first().waitFor();
			}
		},
		subject: kind === 'left' ? '.join-main' : '.me-name',
		filmMs: 1_500,
		observe: (page) =>
			page.evaluate(() => ({
				lost: !!document.querySelector('.lost')?.textContent,
				me: document.querySelector('.me-name')?.textContent?.trim() ?? null
			}))
	});
}

/** A fresh context that is already this phone's singer, so each of the three runs gets its own page. */
async function asSinger(
	browser: Browser,
	world: World,
	opts: BrowserContextOptions,
	state: Page,
	width = 390
): Promise<Page> {
	const ctx = await browser.newContext({
		...opts,
		viewport: { width, height: 844 },
		baseURL: world.baseURL,
		storageState: await state.context().storageState()
	});
	return ctx.newPage();
}

/** A joined phone at `width` whose first song has started and ended, the state Keep me is offered in. Starts this
 *  row's worker and makes the song on the first call. */
const madeSong = new WeakSet<World>();
async function sungPhone(
	browser: Browser,
	world: World,
	cleanup: (fn: () => Promise<unknown>) => void,
	width: number,
	opts: BrowserContextOptions = {}
): Promise<Page> {
	const ctx = await browser.newContext({
		...opts,
		viewport: { width, height: width === 320 ? 568 : 844 },
		baseURL: world.baseURL
	});
	const page = await ctx.newPage();
	await world.joinAs(page, `Keep${++joins}`);
	if (!madeSong.has(world)) {
		madeSong.add(world);
		const worker = await startFakeWorker(world);
		cleanup(() => worker.stop());
		// The TV is what ends a song, so the next run's guest gets their turn.
		await world.openTv();
		await readySong(world, page, 'caroline');
		await page.goto('/');
	}
	await singOnce(page, 'caroline');
	await expect(page.locator(SEL.npStripTitle)).toHaveCount(0, { timeout: 30_000 });
	return page;
}

async function keptPhone(browser: Browser, world: World, cleanup: (fn: () => Promise<unknown>) => void, width: number) {
	const page = await sungPhone(browser, world, cleanup, width);
	await page.goto('/settings/you');
	await page.getByRole('button', { name: 'Keep me', exact: true }).click();
	await expect(page.getByRole('heading', { name: /is kept on this phone/ })).toBeVisible();
	return page;
}

function keepMe(width: number): Make {
	return (browser, world, cleanup) => ({
		name: `phone-keep-me-${width}`,
		what: `Phone ${width}: Keep me tapped after a first song; the offer gives way to "<name> is kept on this phone" (a cut)`,
		stepMs: 33,
		scale: 1,
		columns: 5,
		open: async (opts) => {
			const page = await sungPhone(browser, world, cleanup, width, opts);
			await page.goto('/settings/you');
			await expect(page.getByRole('button', { name: 'Keep me', exact: true })).toBeVisible();
			await page.evaluate(() => document.fonts.ready.then(() => true));
			return page;
		},
		trigger: (page) => page.getByRole('button', { name: 'Keep me', exact: true }).click(),
		subject: '#kept',
		observe: (page) => page.evaluate(() => ({ kept: !!document.querySelector('#kept') }))
	});
}

/** Redesign step 5: Maya's On deck card turning "You're up" as Theo's song ends, the same card at the same height (one
 *  box, #1154), with the list under it still. Each run drains the room and queues Theo's song, then Maya's. */
function deckToUp(width: number): Make {
	return (browser, world, cleanup) => {
		let ph: { theo: Page; maya: Page } | undefined;
		return {
			name: `phone-queue-on-deck-to-up-${width}`,
			what: `Phone ${width}x${width === 320 ? 568 : 844}: Theo's song ends and Maya's On deck card turns "You're up" in place, one box at one height (CLS 0)`,
			stepMs: 33,
			scale: 1,
			columns: 5,
			open: async (opts) => {
				if (!ph) {
					const worker = await startFakeWorker(world, { seconds: HELD_SECS });
					cleanup(() => worker.stop());
					ph = { theo: await world.openPhone('Theo'), maya: await world.openPhone('Maya') };
					await readySong(world, ph.theo, 'caroline');
					await readySong(world, ph.theo, 'believin');
					await world.openTv();
				}
				await drain(ph.theo);
				await queueReady(ph.theo, 'caroline');
				await queueReady(ph.maya, 'believin');
				const page = await asSinger(browser, world, opts, ph.maya, width);
				await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
				await page.goto('/queue');
				await expect(page.locator(`${SEL.queueMyCard}:not(.up)`)).toBeVisible({ timeout: 15_000 });
				await page.evaluate(() => document.fonts.ready.then(() => true));
				// Past the settle window, so the skip lands on Theo's song.
				await page.waitForTimeout(SETTLE_MS + 200);
				return page;
			},
			trigger: async (page) => {
				await sendPlayerCommand(ph!.theo, { cmd: 'skip' });
				await expect(page.locator(`${SEL.queueMyCard}.up`)).toBeVisible({ timeout: 10_000 });
			},
			subject: SEL.queueMyCard,
			observe: (page) =>
				page.evaluate(() => {
					const card = document.querySelector('.deck');
					const r = card?.getBoundingClientRect();
					return { up: !!card?.classList.contains('up'), top: r?.top ?? null, height: r?.height ?? null };
				})
		};
	};
}

/** The host's Reset phones confirm opening on /host, over a kept person (the reset itself never runs). */
function hostResetDialog(width: number): Make {
	let host: Page | undefined;
	return (browser, world, cleanup) => ({
		name: `phone-host-reset-dialog-${width}`,
		what: `Phone ${width}: the host's "Reset Theo's phones" confirm opening (encore-alert-in + encore-scrim-in, --motion-fast)`,
		stepMs: 12,
		scale: 1,
		columns: 6,
		open: async (opts) => {
			if (!host) {
				await keptPhone(browser, world, cleanup, width);
				host = await world.openPhone(`Host${++joins}`);
				await world.becomeHost(host);
			}
			const page = await asSinger(browser, world, opts, host, width);
			await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
			await page.goto('/host');
			await expect(page.getByRole('heading', { name: 'Kept phones' })).toBeVisible();
			await page.evaluate(() => document.fonts.ready.then(() => true));
			return page;
		},
		trigger: async (page) => {
			await page.getByRole('button', { name: /^Reset .* phones$/ }).click();
			await page.locator('[role="alertdialog"]').waitFor({ state: 'attached' });
		},
		subject: '[role="alertdialog"]',
		observe: (page) => page.evaluate(() => ({ dialogOpen: !!document.querySelector('[role="alertdialog"]') }))
	});
}

/** The Delete me confirm opening on a kept phone: the alert dialog's own motion. */
function deleteMeDialog(width: number): Make {
	let kept: Page | undefined;
	return (browser, world, cleanup) => ({
		name: `phone-delete-me-dialog-${width}`,
		what: `Phone ${width}: the "Delete me" confirm opening on a kept phone (encore-alert-in + encore-scrim-in, --motion-fast)`,
		stepMs: 12,
		scale: 1,
		columns: 6,
		open: async (opts) => {
			kept ??= await keptPhone(browser, world, cleanup, width);
			const page = await asSinger(browser, world, opts, kept, width);
			await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
			await page.goto('/settings/you');
			await expect(page.getByRole('button', { name: 'Delete me' })).toBeVisible();
			await page.evaluate(() => document.fonts.ready.then(() => true));
			return page;
		},
		trigger: async (page) => {
			await page.getByRole('button', { name: 'Delete me' }).click();
			await page.locator('[role="alertdialog"]').waitFor({ state: 'attached' });
		},
		subject: '[role="alertdialog"]',
		observe: (page) => page.evaluate(() => ({ dialogOpen: !!document.querySelector('[role="alertdialog"]') }))
	});
}

/** A kept phone back on the scanned join: "Welcome back", then "I'm someone else" opens the guest form (a cut). */
function welcomeBack(width: number): Make {
	let left: Page | undefined;
	return (browser, world, cleanup) => ({
		name: `phone-welcome-back-${width}`,
		what: `Phone ${width}: a kept phone's "Welcome back" join, then "I'm someone else" swapping in the name field and ring (a cut)`,
		stepMs: 33,
		scale: 1,
		columns: 5,
		open: async (opts) => {
			if (!left) {
				left = await keptPhone(browser, world, cleanup, width);
				await left.getByRole('button', { name: 'Leave the room' }).click();
				await left.getByRole('button', { name: 'Yes, leave' }).click();
				await left.waitForURL((u) => u.pathname === '/');
			}
			const page = await asSinger(browser, world, opts, left, width);
			await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
			await page.goto(`/?room=${encodeURIComponent(world.code)}`);
			await expect(page.getByText('Welcome back')).toBeVisible();
			await page.evaluate(() => document.fonts.ready.then(() => true));
			return page;
		},
		trigger: (page) => page.getByRole('button', { name: "I'm someone else" }).click(),
		subject: SEL.nameInput,
		observe: (page) => page.evaluate(() => ({ welcome: document.body.textContent?.includes('Welcome back') ?? false }))
	});
}

/** Skip whatever is on until the room is empty. Each skip waits past the strip's settle window (SETTLE_MS, #974),
 *  so the next skip names the song now on it. */
async function drain(phone: Page): Promise<void> {
	await openQueue(phone);
	const skip = phone.getByRole(SEL.skip.role, { name: SEL.skip.name }).first();
	for (let i = 0; i < 5 && (await skip.isVisible()); i++) {
		await skip.click();
		await phone.waitForTimeout(SETTLE_MS + 250);
	}
	await expect(phone.locator(SEL.npStripTitle)).toHaveCount(0, { timeout: 10_000 });
}

/** Drain the room, then Maya singing caroline past her intro card, with Theo next. */
async function mayaThenTheo(phones: { maya: Page; theo: Page; ana: Page }): Promise<void> {
	const { maya, theo, ana } = phones;
	await drain(ana);
	await queueReady(maya, 'caroline');
	await queueReady(theo, 'believin');
	await expect(ana.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 30_000 });
	// Past the playhead's first second, so the sheet is for Theo's song starting, and past the settle window.
	await ana.waitForTimeout(3_000);
}

/** The dock's box and what its strip is showing, for every dock row's `observe`. */
const readDock = (page: Page) =>
	page.evaluate(() => {
		const r = document.querySelector('.dock')!.getBoundingClientRect();
		const key = document.querySelector('.dock .cheer-key');
		return {
			dock: { y: r.y, h: r.height },
			keyInert: key?.hasAttribute('inert') ?? null,
			tray: !!document.querySelector('.dock .cheers'),
			text: document.querySelector('.dock .strip .meta')?.textContent?.trim() ?? null
		};
	});

/** Phones for the dock rows: Maya, Theo and Ana with a fake worker, two songs ready and a TV. */
async function dockPhones(world: World, cleanup: (fn: () => Promise<unknown>) => void) {
	const worker = await startFakeWorker(world);
	cleanup(() => worker.stop());
	const ph = {
		maya: await world.openPhone('Maya'),
		theo: await world.openPhone('Theo'),
		ana: await world.openPhone('Ana')
	};
	await readySong(world, ph.maya, 'caroline');
	await readySong(world, ph.maya, 'believin');
	await world.openTv();
	return ph;
}

/** The dock as the song becomes yours, at one phone width: the Cheer key fades out IN PLACE (opacity,
 *  --motion-base) and keeps its slot, so neither the strip nor the dock moves. "You're up" rises over it in the
 *  same moment and is listed under live.others. CLS must read 0 in metrics.json, and the dock is 91 px tall. */
function dockYourSong(width: number): Make {
	return (browser, world, cleanup) => {
		let ph: { maya: Page; theo: Page; ana: Page } | undefined;
		return {
			name: `phone-dock-your-song-${width}`,
			what: `Phone ${width}x844: the dock as Theo’s song starts — the Cheer key fades out in place (opacity, --motion-base), no band and no shift (CLS 0)`,
			stepMs: 33,
			scale: 1,
			columns: 5,
			open: async (opts) => {
				ph ??= await dockPhones(world, cleanup);
				await mayaThenTheo(ph);
				const page = await asSinger(browser, world, opts, ph.theo, width);
				await page.goto('/');
				await expect(page.locator(SEL.npStripTitle)).toContainText(/caroline/i);
				await expect(page.locator(SEL.npCheerKey)).toBeVisible();
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				await transportTap(ph!.ana, 'skip');
				await page.locator(`${SEL.npCheerKey}[inert]`).waitFor({ state: 'attached', timeout: 5_000 });
			},
			only: '.cheer-key',
			// The strip, not the key: the key fades to opacity 0 by design, while the strip keeps its place.
			subject: SEL.npStrip,
			stripClip: async () => ({ x: 0, y: 604, width, height: 240 }),
			observe: readDock
		};
	};
}

/** A fan (Theo, while Maya sings) at 390x844, the strip in front of them. `open` lands on the transport, or with
 *  `cheering` on the open tray. */
function fanDock(
	name: string,
	what: string,
	row: Pick<MotionScenario, 'trigger' | 'only' | 'subject'> & { cheering?: boolean }
): Make {
	return (browser, world, cleanup) => {
		let ph: { maya: Page; theo: Page; ana: Page } | undefined;
		return {
			name,
			what,
			stepMs: 33,
			scale: 1,
			columns: 5,
			open: async (opts) => {
				ph ??= await dockPhones(world, cleanup);
				await drain(ph.ana);
				await queueReady(ph.maya, 'caroline');
				await expect(ph.ana.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 30_000 });
				const page = await asSinger(browser, world, opts, ph.theo);
				await page.goto('/');
				await expect(page.locator(SEL.npCheerKey)).toBeVisible();
				if (row.cheering) {
					await page.locator(SEL.npCheerKey).click();
					await expect(page.locator(SEL.npCheers)).toBeVisible();
				}
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: row.trigger,
			only: row.only,
			subject: row.subject,
			// The tray's 6 s return is a wall-clock timeout: it would close the tray between seeked frames.
			holdTimers: true,
			stripClip: async () => ({ x: 0, y: 664, width: 390, height: 180 }),
			observe: readDock
		};
	};
}

/** The now-line heart (proposal 36): a CUT. Theo, a fan while Maya sings, taps it; the mark fills and the words become
 *  "<song> is in your songs", in place. Each run starts unsaved, since the harness opens the row more than once. */
function heartSave(): Make {
	return (browser, world, cleanup) => {
		let ph: { maya: Page; theo: Page; ana: Page } | undefined;
		return {
			name: 'phone-heart-save',
			what: 'Phone 390x844: Theo taps the heart while Maya sings — the mark fills and the line reads "<song> is in your songs" in place, a cut; the dock does not move',
			stepMs: 33,
			scale: 1,
			columns: 5,
			open: async (opts) => {
				ph ??= await dockPhones(world, cleanup);
				await drain(ph.ana);
				await queueReady(ph.maya, 'caroline');
				await expect(ph.ana.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 30_000 });
				const page = await asSinger(browser, world, opts, ph.theo);
				await page.request.delete(`/api/me/songs/${(await world.awaitDemoTrack('caroline')).id}`);
				await page.goto('/');
				await expect(page.locator(`${SEL.npStrip} .heart`)).toHaveAttribute('aria-pressed', 'false');
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				await page.locator(`${SEL.npStrip} .heart`).click();
				await page.locator(`${SEL.npStrip} .saved-note`).waitFor({ state: 'attached', timeout: 5_000 });
			},
			only: STRIP_CONTENT,
			subject: SEL.npStrip,
			// The note's 2 s return is a wall-clock timeout: it would end the note between seeked frames.
			holdTimers: true,
			stripClip: async () => ({ x: 0, y: 664, width: 390, height: 180 }),
			observe: readDock
		};
	};
}

/** Until media `id` has its instrumental, as `readySong` waits, without asking for it to be made. */
async function awaitReady(phone: Page, id: string): Promise<void> {
	await expect
		.poll(
			async () => {
				const body = (await phone.request.get('/api/library').then((r) => r.json())) as {
					library: { id: string; instrumentalRef?: string | null }[];
				};
				return body.library.some((m) => m.id === id && !!m.instrumentalRef);
			},
			{ timeout: 60_000, message: `${id} never reached ready` }
		)
		.toBe(true);
}

/** Maya drags the LAST queued row toward the top while Theo is On deck (proposal 14). The drop stops at 2nd, under
 *  Theo's row, which has no grip on her phone, and on release "Theo’s on deck. Ana goes right after." appears under
 *  "Queued" — a CUT: the line has no animation. The rows' own slide and number roll are the existing reorder motion,
 *  outside `only` (--motion-slide, --motion-roll and --motion-pop). The last row is whichever of Ana's two
 *  songs a previous run left there, so every run makes the same move. */
function reorderHeld(width: number): Make {
	return (browser, world, cleanup) => {
		let maya: Page | undefined;
		return {
			name: `phone-reorder-held-${width}`,
			what: `Phone ${width}x844: Maya drags Ana’s song toward the top while Theo is On deck — it stops at 2nd under Theo’s grip-less row, and one line says why`,
			stepMs: 20,
			scale: 1,
			columns: 5,
			open: async (opts) => {
				if (!maya) {
					const worker = await startFakeWorker(world, { seconds: HELD_SECS });
					cleanup(() => worker.stop());
					maya = await world.openPhone('Maya');
					const theo = await world.openPhone('Theo');
					const ana = await world.openPhone('Ana');
					for (const q of ['caroline', 'believin', 'prayer', 'brightside']) await readySong(world, maya, q);
					const tv = await world.openTv();
					await queueReady(maya, 'caroline');
					await expect(tv.locator(SEL.stateNext)).toBeHidden({ timeout: 30_000 });
					await queueReady(theo, 'believin');
					await queueReady(ana, 'prayer');
					await queueReady(ana, 'brightside');
				}
				const page = await asSinger(browser, world, opts, maya, width);
				await page.goto('/');
				await openQueue(page);
				await expect(page.locator(SEL.queueRow)).toHaveCount(3);
				// Centred, not merely "in view": the fixed dock covers the bottom of the page, and a press there hits the dock.
				await page
					.locator(SEL.queueRow)
					.last()
					.evaluate((el) => el.scrollIntoView({ block: 'center' }));
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				const grip = page.locator(SEL.queueRow).last().locator(SEL.queueGrip);
				const a = (await grip.boundingBox())!;
				const top = (await page.locator(SEL.queueRow).first().boundingBox())!;
				await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
				await page.mouse.down();
				for (let i = 1; i <= 8; i++)
					await page.mouse.move(a.x + a.width / 2, a.y + ((top.y - 20 - a.y) * i) / 8, { steps: 2 });
				await page.mouse.up();
				await page.locator('.reorder-note').waitFor({ timeout: 5_000 });
			},
			only: '.reorder-note',
			subject: '.reorder-note',
			stripClip: async (page) => {
				const box = await page.locator('.grouphead').boundingBox();
				return box ? { x: 0, y: Math.max(0, box.y - 8), width, height: 340 } : undefined;
			},
			observe: (page) =>
				page.evaluate(() => ({
					note: document.querySelector('.reorder-note')?.textContent?.trim() ?? null,
					rows: [...document.querySelectorAll('.qrow')].map((r) => ({
						grip: !!r.querySelector('[data-grip]'),
						text: (r as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 40)
					}))
				}))
		};
	};
}

/** Theo's /queue as the Now row comes (`arrive`: the room's first song) or goes (`leave`: that song skipped,
 *  nothing behind it). What is under the row is held where it was drawn and eases to its new place (`data-hold`,
 *  --motion-base), so nothing jumps. Arriving, the card then fades into the opened slot on the next
 *  --motion-base; leaving, it is a cut. Each run first puts the room in the state before. CLS in metrics.json also
 *  counts the fixed dock, whose top edge moves as the strip comes or goes: the phone layout's. */
function queueCard(moment: 'arrive' | 'leave', width = 390): Make {
	return (browser, world, cleanup) => {
		let maya: Page | undefined;
		let theo: Page | undefined;
		const skip = () => maya!.getByRole(SEL.skip.role, { name: SEL.skip.name }).first();
		return {
			name: `phone-queue-card-${moment}${width === 390 ? '' : `-${width}`}`,
			what:
				moment === 'arrive'
					? `Phone ${width}x844: /queue as the room’s first song starts — the empty state eases down from where it was (transform, --motion-base), then the "Now singing" card fades into the opened slot (opacity, held at 0 for --motion-base, then a --motion-fast fade, 370 ms in all); no jump, never text over text`
					: `Phone ${width}x844: /queue as the last song is skipped — the card goes at once (a cut) and the empty state eases up from where it was (transform, --motion-base), no jump`,
			subject: moment === 'arrive' ? SEL.queueNowCard : 'main .empty-slot',
			stepMs: 33,
			scale: 1,
			columns: 5,
			open: async (opts) => {
				if (!maya || !theo) {
					const worker = await startFakeWorker(world);
					cleanup(() => worker.stop());
					maya = await world.openPhone('Maya');
					theo = await world.openPhone('Theo');
					await readySong(world, maya, 'caroline');
				}
				await openQueue(maya);
				const playing = await skip().isVisible();
				if (moment === 'arrive' && playing) await skip().click();
				if (moment === 'leave' && !playing) {
					await queueReady(maya, 'caroline');
					await openQueue(maya);
				}
				await expect(maya.locator(SEL.npStripTitle)).toHaveCount(moment === 'arrive' ? 0 : 1, { timeout: 10_000 });
				const page = await asSinger(browser, world, opts, theo, width);
				await page.goto('/queue');
				if (moment === 'arrive') await expect(page.getByText('Nothing queued yet')).toBeVisible();
				else await expect(page.locator(SEL.queueNowCard)).toContainText(/caroline/i);
				await page.waitForTimeout(1_000);
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				if (moment === 'arrive') {
					await queueReady(maya!, 'caroline');
					await page.locator(SEL.queueNowCard).waitFor({ timeout: 10_000 });
				} else {
					await skip().click();
					await page.locator(SEL.queueNowCard).waitFor({ state: 'detached', timeout: 10_000 });
				}
			},
			only: '.now, .empty-slot',
			stripClip: async () => ({ x: 0, y: 0, width, height: 600 }),
			observe: (page) =>
				page.evaluate(() => ({
					card: !!document.querySelector('main .now'),
					underTop: document.querySelector('main .empty-slot')?.getBoundingClientRect().top ?? null
				}))
		};
	};
}

/** Theo's /queue at one phone width as his own song starts (proposal 18, redesign step 5): his On deck card turns
 *  "Your song" in place at the same height, and his row leaves the list, so the rows under it ease up from where they
 *  were drawn (`data-hold`, transform, --motion-base). Under reduced motion it is a cut. Each run first drains the
 *  room and queues Maya, Theo, Ana, Maya again. */
function queueYourSong(width: number): Make {
	return (browser, world, cleanup) => {
		let ph: { maya: Page; theo: Page; ana: Page } | undefined;
		const DECK = 'section[aria-label="On deck"]';
		return {
			name: `phone-queue-your-song-${width}`,
			what: `Phone ${width}x844: /queue as Theo’s own song starts — his card turns "Your song" in place at one height, and the rows under it ease up into his row's place (transform, --motion-base), one glide and no jump; a cut under reduced motion`,
			// Not the heading: at 390 it is held at its old top, under the fold, on the first frame.
			subject: 'main > .below',
			stepMs: 33,
			scale: 1,
			columns: 5,
			open: async (opts) => {
				if (!ph) {
					const worker = await startFakeWorker(world, { seconds: HELD_SECS });
					cleanup(() => worker.stop());
					ph = {
						maya: await world.openPhone('Maya'),
						theo: await world.openPhone('Theo'),
						ana: await world.openPhone('Ana')
					};
					for (const q of ['caroline', 'believin', 'prayer', 'bohemian']) await readySong(world, ph.maya, q);
				}
				await drain(ph.ana);
				await queueReady(ph.maya, 'caroline');
				await queueReady(ph.theo, 'believin');
				await queueReady(ph.ana, 'prayer');
				await queueReady(ph.maya, 'bohemian');
				await expect(ph.ana.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 30_000 });
				await ph.ana.waitForTimeout(SETTLE_MS + 250);
				const page = await asSinger(browser, world, opts, ph.theo, width);
				await page.goto('/queue');
				await expect(page.locator(DECK)).toBeVisible({ timeout: 10_000 });
				await page.waitForTimeout(1_000);
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				await transportTap(ph!.maya, 'skip');
				await page.locator(DECK).waitFor({ state: 'detached', timeout: 10_000 });
			},
			// No You're up flood here: on Queue the card says it (redesign step 6).
			only: 'main .grouphead, main .qrow',
			stripClip: async () => ({ x: 0, y: 0, width, height: 844 }),
			observe: (page) =>
				page.evaluate(() => ({
					deck: !!document.querySelector('section[aria-label="On deck"]'),
					headTop: document.querySelector('main .grouphead')?.getBoundingClientRect().top ?? null
				}))
		};
	};
}

/** The line at +250 ms, +1 s (inside the 1.5 s hold) and +2.2 s (settled), read by the page itself so the capture's
 *  own pacing cannot move them. The spec asserts all three (`HELD`). */
const HOLD_SAMPLES = { at250: 250, at1000: 1000, settled: 2200 };

function stalledRetryRow(browser: Browser, world: World, afterTtl: boolean): MotionScenario {
	let maya: Page | undefined;
	// Before the tap: no worker, so the dead card follows the room's verdict either side of the TTL (ruling 38), and a
	// Try again that changes nothing ends on the words it started from.
	const before = "Can't make this one right now";
	return {
		name: afterTtl ? 'phone-stalled-retry-after-ttl' : 'phone-stalled-retry',
		what: `Phone 390x844, no worker${afterTtl ? ', after the TTL' : ''}: Try again on a dead card — the line pops to "Trying again…" (pop, --motion-base), holds 1.5 s, then the stalled line`,
		stepMs: 16,
		scale: 1,
		columns: 6,
		only: '.qrow.proc .progress, .qrow.proc .progress *',
		// The card's line: present in every frame, whatever it says.
		subject: '.qrow.proc .stage',
		filmMs: HOLD_SAMPLES.settled + 200,
		open: async (opts) => {
			if (!maya) {
				maya = await world.openPhone(`Motion${++joins}`);
				const track = await world.awaitDemoTrack();
				await maya.goto('/?source=local');
				await maya.locator(SEL.search).fill(track.title);
				await maya.locator(SEL.songRow).first().locator(SEL.singAction).click();
			}
			const page = await asSinger(browser, world, opts, maya);
			// AFTER THE TTL MEANS AFTER IT: wait for the server to call the song dead for want of a maker, with no job in
			// flight. A run that opened inside the previous run's 3 s window tapped a job the TTL then killed mid-hold, and
			// that verdict rightly cut the hold short.
			if (afterTtl)
				await expect
					.poll(
						async () => {
							const lib = await (await page.request.get(`${world.baseURL}/api/library`)).json();
							return (lib.noMakerFailed?.length ?? 0) > 0 && !(lib.processing?.length ?? 0);
						},
						{ timeout: 20_000, message: 'the TTL never killed the job' }
					)
					.toBe(true);
			await page.goto('/');
			await openQueue(page);
			await expect(page.locator(SEL.processing).first()).toContainText(before, { timeout: 20_000 });
			await page.evaluate(() => document.fonts.ready.then(() => true));
			return page;
		},
		trigger: async (page) => {
			await page.evaluate((samples) => {
				const w = window as unknown as { __held: Record<string, string | null> };
				const read = () => document.querySelector('.qrow.proc .stage')?.textContent?.trim() ?? null;
				w.__held = {};
				for (const [k, ms] of Object.entries(samples)) setTimeout(() => (w.__held[k] = read()), ms);
			}, HOLD_SAMPLES);
			await page.locator(`${SEL.processing} [data-testid="card-retry"]`).first().click();
			await expect(page.locator(SEL.processing).first()).toContainText('Trying again…');
		},
		observe: async (page) => {
			await page.waitForFunction(() => 'settled' in (window as unknown as { __held: object }).__held, null, {
				timeout: 10_000
			});
			return page.evaluate(() => ({ ...(window as unknown as { __held: Record<string, string | null> }).__held }));
		}
	};
}

/** A copy's chip mid-song (proposal 34): `wake`, a tap on a copy whose chip has gone to sleep fades it in where "Up
 *  next" stands (which yields at once, a cut); `sleep`, 10 s after that tap it fades out and "Up next" is back.
 *  The tap lands mid-stage, away from the chip, so it wakes and never claims. */
function tvCopyChip(kind: 'wake' | 'sleep'): Make {
	return (browser, world, cleanup) => {
		let phone: Page | undefined;
		return {
			name: `tv-copy-chip-${kind}`,
			what:
				kind === 'wake'
					? 'TV 1920x1080, a copy mid-song with its chip asleep: a tap fades "This screen is quiet / Make this the TV" in, top-right, in place of "Up next"'
					: 'TV 1920x1080, a copy mid-song 10 s after a tap: the chip fades out and "Up next" is back in its place',
			stepMs: 33,
			scale: 0.5,
			columns: 5,
			startTimeoutMs: kind === 'wake' ? 1_500 : 12_000,
			open: async (opts) => {
				if (!phone) {
					const worker = await startFakeWorker(world, { seconds: ROOM_SCREEN_TRACK.seconds });
					cleanup(() => worker.stop());
					phone = await world.openPhone('Ana');
					await readySong(world, phone, 'room-screen');
					await readySong(world, phone, 'caroline');
					await queueReady(phone, 'room-screen');
					await queueReady(phone, 'caroline');
				}
				const seat = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: world.baseURL });
				cleanup(() => seat.close());
				await seat.addCookies([world.tvCookie]);
				const real = await seat.newPage();
				await real.goto(`/tv?room=${encodeURIComponent(world.code)}`);
				await expect(real.locator('.lower-third')).toContainText(/Ana/, { timeout: 30_000 });
				const ctx = await browser.newContext({
					...opts,
					viewport: { width: 1920, height: 1080 },
					baseURL: world.baseURL
				});
				cleanup(() => ctx.close());
				const page = await ctx.newPage();
				await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
				// "Up next" shows while a turn waits behind this one; the later runs of five can outlast that turn.
				await expect(page.locator('.lower-third')).toContainText(/Ana/, { timeout: 30_000 });
				await expect(page.locator(SEL.stateNext)).toHaveCount(0, { timeout: 15_000 });
				// `wake` waits out the 20 s the chip shows after the screen opens; `sleep` taps, which starts its 10 s over.
				if (kind === 'wake') await expect(page.locator('.copy-slot.asleep')).toBeAttached({ timeout: 30_000 });
				else {
					await page.mouse.click(960, 540);
					await expect(page.locator('.copy-slot:not(.asleep)')).toBeAttached();
				}
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				if (kind === 'wake') await page.mouse.click(960, 540);
				// Every frame, so the timer hold below is in place well before "Up next"'s 250 ms is up.
				else
					await page.waitForFunction(() => !!document.querySelector('.copy-slot.asleep'), null, {
						polling: 'raf',
						timeout: 12_000
					});
			},
			// "Up next" returns on a timer once the fade is over; the seek run's frozen frames would see it early.
			holdTimers: kind === 'sleep',
			// Leaving, the chip is gone in the settled frame, so the subject is the join card the room keeps throughout.
			subject: kind === 'wake' ? '.copy-chip' : '.corner',
			only: '.copy-slot'
		};
	};
}

/** A copy mid-song as the room's TV drops (proposal 19): its chip's line turns from "This screen is quiet" to
 *  "The TV is reconnecting...", as a CUT, in the same chip and place. Each run seats a fresh real TV (its cookie, so it
 *  is the holder again inside the grace) and opens a fresh copy at this size; the trigger closes the real TV's tab. */
function tvCopyOffline(width: number, height: number): Make {
	return (browser, world, cleanup) => {
		let phone: Page | undefined;
		let tv: BrowserContext | undefined;
		return {
			name: width === 1920 ? 'tv-copy-offline' : `tv-copy-offline-${width}`,
			what: `${width === 1920 ? 'TV' : 'Phone'} ${width}x${height}, a copy mid-song: the room's TV tab closes and the chip's line turns to "The TV is reconnecting...", as a CUT. Same chip, same button`,
			stepMs: 33,
			scale: width === 1920 ? 0.5 : 1,
			columns: 5,
			startTimeoutMs: 1_500,
			open: async (opts) => {
				if (!phone) {
					const worker = await startFakeWorker(world, { seconds: LONG_TRACK.seconds });
					cleanup(() => worker.stop());
					phone = await world.openPhone('Ana');
					await readySong(world, phone, 'long');
				}
				if (!(await phone.locator(SEL.npStripTitle).count())) await queueReady(phone, 'long');
				await expect(phone.locator(SEL.npStripTitle)).toContainText(/long/i, { timeout: 30_000 });
				const seat = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: world.baseURL });
				cleanup(() => seat.close());
				tv = seat;
				await tv.addCookies([world.tvCookie]);
				const real = await tv.newPage();
				await real.goto(`/tv?room=${encodeURIComponent(world.code)}`);
				await expect(real.locator('.lower-third')).toContainText(/Ana/, { timeout: 30_000 });
				const ctx = await browser.newContext({ ...opts, viewport: { width, height }, baseURL: world.baseURL });
				cleanup(() => ctx.close());
				const page = await ctx.newPage();
				await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
				await expect(page.locator('.copy-chip')).toContainText('This screen is quiet', { timeout: 15_000 });
				await expect(page.locator(SEL.stateNext)).toHaveCount(0, { timeout: 15_000 });
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				await tv!.close();
				await expect(page.locator('.copy-chip')).toContainText('The TV is reconnecting...');
			},
			subject: '.copy-chip',
			only: '.copy-chip, .copy-chip *',
			observe: (page) =>
				page.evaluate(() => ({ line: document.querySelector('.copy-line')?.textContent?.trim() ?? null }))
		};
	};
}

/** A song that won't play (proposal 11): Maya skips, Theo's file is dead on this TV, and the "Skipped" takeover names
 *  whose song it was and who replaces it, then hands to Ana's "Now singing" card. It moves as #1018's handoff layer
 *  does: the layer fades in with the notice, and at the hand-off the scrim stays up while only the lines rise. Each run
 *  drains the room, and Theo takes his held turn off with the queue's ✕ so he can queue the song again. */
function songFailed(toCard: boolean): Make {
	return (browser, world, cleanup) => {
		let ph: { maya: Page; theo: Page; ana: Page } | undefined;
		let theoMedia = '';
		const skipToNotice = async (page: Page) => {
			await transportTap(ph!.maya, 'skip');
			await expect(page.locator(SEL.stateError)).toBeVisible({ timeout: 5_000 });
		};
		return {
			name: toCard ? 'tv-song-failed-to-card' : 'tv-song-failed',
			what: toCard
				? 'TV 1920x1080: the hand-off as the Skipped notice clears to Ana’s "Now singing" card: the scrim stays up and only the new lines rise (--motion-slow)'
				: 'TV 1920x1080: "Skipped · Theo’s song wouldn’t play · Up next - Ana" the moment a dead file comes up: the layer fades in and the lines rise (--motion-slow)',
			stepMs: 33,
			scale: 0.5,
			columns: 5,
			startTimeoutMs: 1_500,
			open: async (opts) => {
				if (!ph) {
					const worker = await startFakeWorker(world);
					cleanup(() => worker.stop());
					ph = {
						maya: await world.openPhone('Maya'),
						theo: await world.openPhone('Theo'),
						ana: await world.openPhone('Ana')
					};
					for (const q of ['caroline', 'believin', 'prayer']) await readySong(world, ph.maya, q);
					theoMedia = (await world.awaitDemoTrack('believin')).id;
				}
				await openQueue(ph.theo);
				const held = ph.theo.locator(SEL.queueRemove);
				while ((await held.count()) > 0) {
					await held.first().click();
					await ph.theo.waitForTimeout(300);
				}
				await ph.theo.goto('/');
				const ctx = await browser.newContext({
					...opts,
					viewport: { width: 1920, height: 1080 },
					baseURL: world.baseURL
				});
				// The room's screen (#990's seat): a cookieless TV is a copy, and its `failed` frame moves nothing.
				await ctx.addCookies([world.tvCookie]);
				const page = await ctx.newPage();
				await page.route(`**/*${theoMedia}*`, (r) => r.fulfill({ status: 404, body: '' }));
				await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
				await mayaThenTheo(ph);
				await queueReady(ph.ana, 'prayer');
				await expect(page.locator(SEL.stateNext)).toBeHidden({ timeout: 10_000 });
				await page.evaluate(() => document.fonts.ready.then(() => true));
				if (toCard) await skipToNotice(page);
				return page;
			},
			// The notice row fires the skip; the hand-off row is already on the notice and its trigger is the card arriving.
			trigger: async (page) => {
				if (!toCard) return skipToNotice(page);
				await expect(page.locator(SEL.stateNext, { hasText: 'Ana' })).toBeVisible({ timeout: 6_000 });
				// Stop the page's wall clock with its timers: #1018's early exit is also checked against `Date.now()` when the
				// slot reports ready (`leadExitIfDue`), which `holdTimers` cannot hold, and the seek run's slow real time made
				// it due under the card's rise. In real time the card stands its whole hold.
				await page.evaluate(() => {
					const frozen = Date.now();
					Date.now = () => frozen;
				});
			},
			only: toCard ? '.takeover-layer, .state-next, .state-next *' : '.takeover-layer, .state-error, .state-error *',
			subject: toCard ? '.state-next' : '.state-error',
			// Both takeovers clear on a wall-clock timer (the notice's 4 s, the card's hold), which must not fire between
			// seeked frames and take the subject away.
			holdTimers: true,
			observe: (page) =>
				page.evaluate(() => ({
					notice: document.querySelector('.state-error')?.textContent?.trim() ?? null,
					card: document.querySelector('.state-next')?.textContent?.trim() ?? null
				}))
		};
	};
}

/** "Your song didn't play" (proposal 11, PR 2) rising over the dock on Theo's Library tab, the moment the TV reports his
 *  dead file: in his colour, with Try again and Pick another (`.rise-in`, --motion-base). Each run drains the room, takes
 *  Theo's held turn off with the queue's ✕ so he can queue the song again, and opens a fresh page as Theo. */
function songDidntPlay(width: number): Make {
	return (browser, world, cleanup) => {
		let ph: { maya: Page; theo: Page; ana: Page } | undefined;
		return {
			name: `phone-song-didnt-play-${width}`,
			what: `Phone ${width}x844: "Your song didn’t play" rising over the dock on the Library tab as the TV fails Theo’s song, with Try again and Pick another (rise-in, --motion-base). The 0 ms frame is a seek artefact: in real time the sheet mounts once and starts at opacity 0 (rAF probe, #1047)`,
			stepMs: 16,
			scale: 1,
			columns: 6,
			open: async (opts) => {
				if (!ph) {
					// 36 s stems, so Maya's song is still on while each run opens Theo's page under load.
					const worker = await startFakeWorker(world, { seconds: LONG_TRACK.seconds });
					cleanup(() => worker.stop());
					ph = {
						maya: await world.openPhone('Maya'),
						theo: await world.openPhone('Theo'),
						ana: await world.openPhone('Ana')
					};
					await readySong(world, ph.maya, 'caroline');
					await readySong(world, ph.maya, 'believin');
					const theoMedia = (await world.awaitDemoTrack('believin')).id;
					// The room's screen (#990's seat), with Theo's file dead on it.
					const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: world.baseURL });
					cleanup(() => ctx.close());
					await ctx.addCookies([world.tvCookie]);
					const tv = await ctx.newPage();
					await tv.route(`**/*${theoMedia}*`, (r) => r.fulfill({ status: 404, body: '' }));
					await tv.goto(`/tv?room=${encodeURIComponent(world.code)}`);
				}
				await openQueue(ph.theo);
				const held = ph.theo.locator(SEL.queueRemove);
				while ((await held.count()) > 0) {
					await held.first().click();
					await ph.theo.waitForTimeout(300);
				}
				await ph.theo.goto('/');
				await mayaThenTheo(ph);
				const page = await asSinger(browser, world, opts, ph.theo, width);
				await page.goto('/');
				await page.getByRole('link', { name: 'Library' }).click();
				await expect(page.locator(SEL.npStripTitle)).toContainText(/caroline/i);
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				await transportTap(ph!.ana, 'skip');
				await page.locator('.didnt-play').waitFor({ state: 'attached', timeout: 5_000 });
			},
			only: '.didnt-play',
			subject: '.didnt-play',
			// The dock and the sheet over it.
			stripClip: async () => ({ x: 0, y: 404, width, height: 440 }),
			observe: (page) =>
				page.evaluate(() => ({
					sheet: document.querySelector('.didnt-play')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
					live: document.querySelector('[data-didnt-play-live]')?.textContent?.trim() ?? null,
					youreUp: !!document.querySelector('[data-testid="youre-up-flood"]')
				}))
		};
	};
}

/** The Sing tab's one way wider (proposal 21): `Not it? Search everything` under a default answer re-runs the query
 *  with `source=all`. A CUT: the rows give way to `Searching…` and come back, and the find row above them, the
 *  field alone now, does not move. The page's searches are answered from the local index (`source=local`), because
 *  five runs of two live YouTube lookups each overran the row's budget; the page still sends its own default and
 *  `all` requests, and the probe sing-one-search-box reads those off the wire. */
function singWiden(width: number): Make {
	return (browser, world) => {
		let maya: Page | undefined;
		return {
			name: `phone-sing-widen-${width}`,
			what: `Phone ${width}x844: "Not it? Search everything" under a default answer — the rows are replaced by the wider search's, a cut; the field alone above them does not move (rows from the local index)`,
			stepMs: 16,
			scale: 1,
			columns: 6,
			open: async (opts) => {
				maya ??= await world.openPhone(`Widen${++joins}`);
				const track = await world.awaitDemoTrack();
				const page = await asSinger(browser, world, opts, maya, width);
				await page.route('**/api/search?*', (r) => {
					const u = new URL(r.request().url());
					u.searchParams.set('source', 'local');
					return r.continue({ url: u.toString() });
				});
				await page.goto('/');
				await openBrowseFromHome(page);
				await page.locator(SEL.search).fill(track.title);
				await page.getByRole('button', { name: /Not it\? Search everything/ }).waitFor({ timeout: 30_000 });
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				await page.getByRole('button', { name: /Not it\? Search everything/ }).click();
			},
			only: '.find-row, .find-row *',
			subject: '.find-row',
			observe: (page) =>
				page.evaluate(
					(row) => ({
						findRow: document.querySelector('.find-row')?.getBoundingClientRect().toJSON() ?? null,
						rows: document.querySelectorAll(row).length,
						widenOffered: [...document.querySelectorAll('button')].some((b) =>
							/Search everything/.test(b.textContent ?? '')
						)
					}),
					SEL.songRow
				)
		};
	};
}

/** The Sing tab's Spotlight (redesign step 3) as a guest taps Sing from Queue: the lit card fades in from
 *  scale(.98) over --motion-base, the tab's only motion. It tells the guest where the next thing to do is. */
function singSpotlight(width: number): Make {
	return (browser, world) => {
		let maya: Page | undefined;
		return {
			name: `phone-sing-spotlight-${width}`,
			what: `Phone ${width}: tapping the Sing tab from Queue, the search Spotlight fades in from scale(.98) over --motion-base`,
			stepMs: 12,
			scale: 1,
			columns: 6,
			open: async (opts) => {
				maya ??= await world.openPhone(`Spot${++joins}`);
				const page = await asSinger(browser, world, opts, maya, width);
				if (width === 320) await page.setViewportSize({ width, height: 568 });
				await page.goto('/queue');
				await openQueue(page);
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				await page.locator(SEL.tab).filter({ hasText: 'Sing' }).first().click();
				await page.locator('.find-row .spotlight').waitFor({ state: 'attached' });
			},
			only: '.find-row .spotlight',
			subject: '.find-row .spotlight'
		};
	};
}

/** The one `vite dev` every story row shares; the rows run serially in one worker (see their describe below). */
let storyGallery: Promise<Gallery> | undefined;

/** The Spotlight story (`/components/spotlight`, dev-only, so on `vite dev`): its entrance, the On deck to You're up
 *  handoff, and a Guide segment tap, which is a cut. Only transform and opacity may move (tenet 3). */
function spotlightStory(kind: 'enter' | 'handoff' | 'guide', viewport: { width: number; height: number }): Make {
	const tv = viewport.width > 1000;
	const at = tv ? 'tv' : String(viewport.width);
	const ROW = {
		enter: {
			what: 'the four Spotlight states mount: each card fades in from scale(.98) over --motion-base (--ease-out)',
			button: 'replay',
			only: '.spotlight',
			subject: '[data-testid="spot-on-deck"] .spotlight'
		},
		handoff: {
			what: 'On deck becomes You’re up: the fill stays lit and the headline pops (opacity, scale .92), --motion-slow',
			button: 'handoff-toggle',
			only: '[data-testid="spot-handoff"] .spotlight, [data-testid="spot-handoff"] .spotlight *',
			subject: '[data-testid="spot-handoff"] .spotlight'
		},
		guide: {
			what: 'tapping Low on the Guide segments: the press lands in the next frame, a cut with no animation',
			button: null,
			only: '.segments, .segments *',
			subject: '[data-testid="guide-plain"] .segments'
		}
	}[kind];
	return (browser) => {
		return {
			name: `spotlight-${kind}-${at}`,
			what: `${tv ? 'TV 1920x1080' : `Phone ${viewport.width}x${viewport.height}`}: ${ROW.what}`,
			stepMs: kind === 'guide' ? 16 : 33,
			scale: tv ? 0.5 : 1,
			columns: 6,
			open: async (opts) => {
				storyGallery ??= startGallery();
				const ctx = await browser.newContext({ ...opts, viewport });
				const page = await ctx.newPage();
				await (await storyGallery).open(page, '/components/spotlight', ROW.subject);
				await page.evaluate(() => document.fonts.ready.then(() => true));
				// Past the cards' own mount entrance, so the trigger's motion is the only one caught.
				await page.waitForTimeout(600);
				return page;
			},
			trigger: async (page) => {
				if (ROW.button) await page.getByTestId(ROW.button).click();
				else await page.getByTestId('guide-plain').getByRole('radio', { name: 'Low' }).click();
			},
			only: ROW.only,
			subject: ROW.subject,
			observe: (page) =>
				page.evaluate(() => ({
					handoff: document.querySelector('[data-testid="spot-handoff"] .spotlight')?.getAttribute('data-moment'),
					guide: [...document.querySelectorAll('[data-testid="guide-plain"] [role="radio"]')].map(
						(b) => `${b.textContent}:${b.getAttribute('aria-checked')}`
					)
				}))
		};
	};
}

const SCENARIOS: Record<string, Make> = {
	'spotlight-enter-390': spotlightStory('enter', { width: 390, height: 844 }),
	'spotlight-enter-320': spotlightStory('enter', { width: 320, height: 568 }),
	'spotlight-enter-tv': spotlightStory('enter', { width: 1920, height: 1080 }),
	'spotlight-handoff-390': spotlightStory('handoff', { width: 390, height: 844 }),
	'spotlight-handoff-320': spotlightStory('handoff', { width: 320, height: 568 }),
	'spotlight-handoff-tv': spotlightStory('handoff', { width: 1920, height: 1080 }),
	'spotlight-guide-390': spotlightStory('guide', { width: 390, height: 844 }),
	'spotlight-guide-320': spotlightStory('guide', { width: 320, height: 568 }),
	'spotlight-guide-tv': spotlightStory('guide', { width: 1920, height: 1080 }),
	'phone-sing-widen-390': singWiden(390),
	'phone-sing-widen-320': singWiden(320),
	'phone-sing-spotlight-390': singSpotlight(390),
	'phone-sing-spotlight-320': singSpotlight(320),
	'phone-song-didnt-play-390': songDidntPlay(390),
	'phone-song-didnt-play-320': songDidntPlay(320),
	'tv-copy-chip-wake': tvCopyChip('wake'),
	'tv-copy-chip-sleep': tvCopyChip('sleep'),
	'tv-copy-offline': tvCopyOffline(1920, 1080),
	'tv-copy-offline-390': tvCopyOffline(390, 844),
	'tv-copy-offline-320': tvCopyOffline(320, 568),
	'phone-queue-card-arrive': queueCard('arrive'),
	'phone-queue-card-arrive-320': queueCard('arrive', 320),
	'phone-queue-card-leave': queueCard('leave'),
	'phone-queue-your-song-390': queueYourSong(390),
	'phone-queue-your-song-320': queueYourSong(320),
	'phone-dock-your-song-390': dockYourSong(390),
	'phone-dock-your-song-320': dockYourSong(320),
	'phone-reorder-held-390': reorderHeld(390),
	'phone-reorder-held-320': reorderHeld(320),
	'phone-heart-save': heartSave(),
	/** The Cheer key swaps the strip for the tray, in place and at the same height (`.rise-in`). */
	'phone-cheers-open': fanDock(
		'phone-cheers-open',
		'Phone 390x844: tapping the Cheer key — the four reactions and ✕ rise into the strip in place (rise-in, --motion-base); the dock does not move',
		{
			trigger: async (page) => {
				await page.locator(SEL.npCheerKey).click();
				await page.locator(SEL.npCheers).waitFor({ state: 'attached', timeout: 5_000 });
			},
			only: '.cheers',
			subject: SEL.npCheers
		}
	),
	/** ✕ gives the strip back to the now-line: a cut, the same height. */
	'phone-cheers-return': fanDock(
		'phone-cheers-return',
		'Phone 390x844: ✕ on the tray — the now-line and Cheer key come back, a cut at the same height',
		{
			cheering: true,
			trigger: async (page) => {
				await page.locator(SEL.npCheersClose).click();
				await page.locator(SEL.npStripLink).waitFor({ state: 'attached', timeout: 5_000 });
			},
			only: STRIP_CONTENT,
			subject: SEL.npStrip
		}
	),
	/** The last song ends: the strip stays and reads "Nothing playing" with no transport. A cut. */
	'phone-dock-idle': fanDock(
		'phone-dock-idle',
		'Phone 390x844: the last song ends — the strip stays at its height and reads “Nothing playing” with no transport, a cut',
		{
			trigger: async (page) => {
				// Off the wire: the transport is on /queue, and the row films this page's dock.
				await sendPlayerCommand(page, { cmd: 'skip' });
				await page.locator(SEL.npStripIdle).waitFor({ state: 'attached', timeout: 5_000 });
			},
			only: STRIP_CONTENT,
			subject: SEL.npStrip
		}
	),
	/** The link drops: "Reconnecting…" takes the title slot instead of growing the dock by a row (a cut), and the
	 *  Cheer key rests in its slot (opacity, --motion-base), since a cheer offline would be dropped. */
	'phone-dock-offline': fanDock(
		'phone-dock-offline',
		'Phone 390x844: the link drops — “Reconnecting…” takes the title slot in --warn (a cut) and the Cheer key fades out in place (--motion-base); the dock does not grow',
		{
			trigger: async (page) => {
				await goOffline(page);
				await page.locator(SEL.npStripOffline).waitFor({ state: 'attached', timeout: 15_000 });
			},
			only: '.dock .cheer-key',
			subject: SEL.npStrip
		}
	),
	'tv-song-failed': songFailed(false),
	'tv-song-failed-to-card': songFailed(true),
	/** "You're up" flooding Theo's Library tab in his colour as a skip makes his song start (redesign step 6). Each run
	 *  drains the room and starts again from Maya's song. */
	'phone-youre-up': (browser, world, cleanup) => {
		let ph: { maya: Page; theo: Page; ana: Page } | undefined;
		return {
			name: 'phone-youre-up',
			what: 'Phone 390x844: "You’re up" flooding the Library tab in Theo’s colour as his song starts (opacity in, the headline popping from 0.92 scale, --motion-slow)',
			stepMs: 16,
			scale: 0.5,
			columns: 6,
			open: async (opts) => {
				if (!ph) {
					// 36 s stems, so Maya's song is still on while each run opens Theo's page under load: an 8 s one
					// could end first and start Theo's song before the trigger.
					const worker = await startFakeWorker(world, { seconds: LONG_TRACK.seconds });
					cleanup(() => worker.stop());
					ph = {
						maya: await world.openPhone('Maya'),
						theo: await world.openPhone('Theo'),
						ana: await world.openPhone('Ana')
					};
					await readySong(world, ph.maya, 'caroline');
					await readySong(world, ph.maya, 'believin');
					await world.openTv();
				}
				await mayaThenTheo(ph);
				const page = await asSinger(browser, world, opts, ph.theo);
				await page.goto('/');
				await page.getByRole('link', { name: 'Library' }).click();
				await expect(page.locator(SEL.npStripTitle)).toContainText(/caroline/i);
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				await transportTap(ph!.ana, 'skip');
				await page.locator('[data-testid="youre-up-flood"]').waitFor({ state: 'attached', timeout: 5_000 });
			},
			only: '[data-testid="youre-up-flood"], [data-testid="youre-up-flood"] p',
			subject: '[data-testid="youre-up-flood"]',
			// The flood's wall-clock dismiss (`youreUpTimer`, +layout.svelte) would otherwise fire between seeked frames.
			holdTimers: true,
			// The whole phone: the flood covers it.
			stripClip: async () => ({ x: 0, y: 0, width: 390, height: 844 }),
			observe: (page) =>
				page.evaluate(() => ({
					sheet: !!document.querySelector('[data-testid="youre-up-flood"]'),
					live: document.querySelector('[data-youre-up-live]')?.textContent ?? null
				}))
		};
	},
	/** The attract phrase swap: `{#key attractPhrase}` remounts the line and `phrase-fade` plays, every 8 s. */
	'tv-attract-phrase': (browser, world) => ({
		name: 'tv-attract-phrase',
		what: 'TV attract screen: the headline phrase rotating every 8 s: a cut, then phrase-fade (600 ms ease-out, a declared exception to the tokens)',
		stepMs: 33,
		scale: 0.5,
		columns: 5,
		// The clock is 8 s from mount, so the first change can be most of that away.
		startTimeoutMs: 9_500,
		open: async (opts) => {
			const ctx = await browser.newContext({
				...opts,
				viewport: { width: 1920, height: 1080 },
				baseURL: world.baseURL
			});
			await ctx.addCookies([world.tvCookie]);
			const page = await ctx.newPage();
			await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
			await expect(page.locator(SEL.attract)).toBeVisible();
			await expect(page.locator(SEL.stageHeadline)).toBeVisible();
			await page.evaluate(() => document.fonts.ready.then(() => true));
			// Let the mount's own phrase-fade finish, so the caught animation is the NEXT swap.
			await page.waitForTimeout(700);
			await page.evaluate(
				() =>
					((window as unknown as { __phrase0: string }).__phrase0 =
						document.querySelector('.phrase-line')!.textContent!)
			);
			return page;
		},
		// Nothing to press — the TV's own clock is the trigger. Waiting for the text to move is what lets the
		// reduced run PROVE the clock is off: there, this times out and the phrase is still the first one.
		trigger: async (page) => {
			await page
				.waitForFunction(
					() =>
						document.querySelector('.phrase-line')?.textContent !==
						(window as unknown as { __phrase0: string }).__phrase0,
					null,
					{ timeout: 9_000, polling: 'raf' }
				)
				.catch(() => {});
		},
		only: '.phrase-line',
		subject: '.phrase-line',
		literalsAllowed: {
			match: 'phrase-fade on div.phrase-line: literal timing 0.6s',
			reason: 'a slower swap for a screen nobody is acting on (tv/TvAttract.svelte)'
		},
		observe: (page) =>
			page.evaluate(() => ({
				phraseBefore: (window as unknown as { __phrase0: string }).__phrase0,
				phraseAfter: document.querySelector('.phrase-line')?.textContent,
				changed:
					document.querySelector('.phrase-line')?.textContent !==
					(window as unknown as { __phrase0: string }).__phrase0,
				lineNodes: document.querySelectorAll('.phrase-line').length
			})),
		stripClip: async (page) => {
			const box = await page.locator('.asplit-l').boundingBox();
			return box ? { x: box.x, y: box.y + box.height * 0.2, width: box.width, height: box.height * 0.6 } : undefined;
		}
	}),

	/** Try again on a card no worker can make: the server answers "still unservable" within a frame, so without an
	 *  acknowledgement nothing on the card moved and the tap read as dead. The line pops to "Trying again…"
	 *  (`pop` at --motion-base) and HOLDS a flat 1.5 s, then the card shows the room's latest word (stalled).
	 *  ONE singer and ONE turn for every run: once the song is cooking its Sing row has no sing action, so each run
	 *  reopens /queue as that singer and waits for the hold from the previous run's tap to lapse. */
	'phone-stalled-retry': (browser, world) => stalledRetryRow(browser, world, false),

	/** The same tap AFTER the TTL killed the job: a NEW job, whose first frame is a stage the server synthesised. Round
	 *  5's hold ended on it at ~100 ms. The core's TTL is shortened (`CORE_ENV`) so every run taps a freshly dead song. */
	'phone-stalled-retry-after-ttl': (browser, world) => stalledRetryRow(browser, world, true),

	/** The leave confirm opening: bits-ui AlertDialog, encore-alert-in (scale .96→1 + fade) over encore-scrim-in. */
	'phone-leave-dialog': (browser, world) => ({
		name: 'phone-leave-dialog',
		what: 'Phone 390x844: the "Leave the room" confirm opening (encore-alert-in + encore-scrim-in, --motion-fast)',
		stepMs: 12,
		scale: 1,
		columns: 6,
		open: async (opts) => {
			const ctx = await browser.newContext({ ...opts, viewport: { width: 390, height: 844 }, baseURL: world.baseURL });
			const page = await ctx.newPage();
			await world.joinAs(page, `Motion${++joins}`);
			await page.goto('/settings/you');
			await expect(page.getByRole('button', { name: 'Leave the room' })).toBeVisible();
			await page.evaluate(() => document.fonts.ready.then(() => true));
			return page;
		},
		trigger: async (page) => {
			await page.getByRole('button', { name: 'Leave the room' }).click();
			await page.locator('[role="alertdialog"]').waitFor({ state: 'attached' });
		},
		subject: '[role="alertdialog"]',
		observe: (page) => page.evaluate(() => ({ dialogOpen: !!document.querySelector('[role="alertdialog"]') }))
	}),

	/** Keep me after a first song (proposal 30): the offer gives way to the kept card. A cut. Each run is a new
	 *  guest who sings once, since a guest can be kept only once. */
	'phone-keep-me-390': keepMe(390),
	'phone-keep-me-320': keepMe(320),
	'phone-delete-me-dialog-390': deleteMeDialog(390),
	'phone-delete-me-dialog-320': deleteMeDialog(320),
	'phone-welcome-back-390': welcomeBack(390),
	'phone-welcome-back-320': welcomeBack(320),
	'phone-host-reset-dialog-390': hostResetDialog(390),
	'phone-host-reset-dialog-320': hostResetDialog(320),

	/** On deck crossing into the heads-up, for real: Theo sings a 36 s track on a real TV, so Maya's card starts as
	 *  "After Theo" with its time-left and, 30 s from the end, says "Grab the mic": the class, the meta words and the
	 *  time-left all change in one update, a cut on a card already filled in her colour. Each run restarts Theo's song
	 *  so it opens before the crossing. Needs the long track in this file's library (`LIBRARY`). */
	'phone-tab-left-390': otherTab('left', 390),
	'phone-tab-left-320': otherTab('left', 320),
	'phone-tab-adopted-390': otherTab('adopted', 390),
	'phone-tab-adopted-320': otherTab('adopted', 320),

	'phone-on-deck-heads-up': (browser, world, cleanup) => {
		let theo: Page | undefined;
		let maya: Page | undefined;
		return {
			name: 'phone-on-deck-heads-up',
			what: 'Phone 390x844: the on-deck card crossing 30 s left on a real 36 s song — "After Theo" + time-left → "Grab the mic", the card already filled in the singer colour, a cut in place',
			stepMs: 33,
			scale: 1,
			columns: 5,
			open: async (opts) => {
				if (!theo || !maya) {
					const worker = await startFakeWorker(world, { seconds: LONG_TRACK.seconds });
					cleanup(() => worker.stop());
					theo = await world.openPhone('Theo');
					maya = await world.openPhone('Maya', { stop: 'End' });
					await readySong(world, theo, 'long-take');
					await readySong(world, theo, 'caroline');
					await queueReady(theo, 'long-take');
					await queueReady(maya, 'caroline');
					await world.openTv();
				}
				// Back before the crossing: from the top, 36 s remain.
				await transportTap(theo, 'restart');
				const page = await asSinger(browser, world, opts, maya);
				await page.goto('/');
				await openQueue(page);
				await expect(page.locator('.deck:not(.heads-up) .meta .end')).not.toBeEmpty();
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			// The song's own clock is the trigger, as on a night.
			trigger: (page) => page.locator('.deck.heads-up').waitFor({ timeout: 20_000 }),
			// The card AND its children, so a child's own animation is seeked too.
			only: '.deck, .deck *',
			subject: '.deck.heads-up',
			// The card and a little of what is around it: the whole 390x844 page in 15 frames is past 2000 px tall.
			stripClip: async (page) => {
				const box = await page.locator('.deck').boundingBox();
				return box ? { x: 0, y: Math.max(0, box.y - 12), width: 390, height: box.height + 24 } : undefined;
			},
			observe: (page) =>
				page.evaluate(() => ({
					headsUp: !!document.querySelector('.deck.heads-up'),
					meta: document.querySelector('.deck .meta span')?.textContent?.trim() ?? null,
					timeLeftShown: !!document.querySelector('.deck .meta .end')?.textContent?.trim()
				}))
		};
	},

	'phone-queue-on-deck-to-up-390': deckToUp(390),
	'phone-queue-on-deck-to-up-320': deckToUp(320),

	/** The processing bar taking one real worker step, with a timer keepalive's `pct: 0` arriving between the real
	 *  figures (proposal 05): the fill only ever grows. One song is made first so the card has a time to show; each
	 *  run then sings a fresh song, so all three passes catch a bar still filling. */
	'phone-processing-bar': (browser, world, cleanup) => {
		const songs = ['caroline', 'bohemian', 'prayer', 'open-road', 'night-drive'];
		let run = 0;
		let ready = false;
		let prev: string | undefined; // the last pass's media id
		let song = '';
		const ownCard = (page: Page) => page.locator(SEL.processing).filter({ hasText: new RegExp(song, 'i') });
		return {
			name: 'phone-processing-bar',
			what: 'Phone 390x844: the processing bar taking one real step ("NN% · under a minute"), keepalive zeros every 250 ms between the figures, the fill growing left to right (--motion-base)',
			stepMs: 33,
			scale: 1,
			columns: 6,
			startTimeoutMs: 8_000,
			open: async (opts) => {
				if (!ready) {
					const quick = await startFakeWorker(world, { workerId: 'box', slowMs: 150, ranAsAsked: true });
					const theo = await world.openPhone('Theo');
					await readySong(world, theo, 'believin');
					await quick.stop();
					const slow = await startFakeWorker(world, {
						workerId: 'box',
						slowMs: 3_000,
						keepaliveMs: 250,
						ranAsAsked: true
					});
					cleanup(() => slow.stop());
					ready = true;
				}
				const ctx = await browser.newContext({
					...opts,
					viewport: { width: 390, height: 844 },
					baseURL: world.baseURL
				});
				const page = await ctx.newPage();
				song = songs[run++ % songs.length]!;
				await world.joinAs(page, `Bar${run}`);
				// The last pass's song finishes first: its card turning into a ready row above this one would
				// shift the layout mid-capture, and it would be a second bar on screen.
				if (prev) await awaitReady(page, prev);
				prev = (await world.awaitDemoTrack(song)).id;
				await openBrowseFromHome(page);
				await page.locator(SEL.search).fill(song);
				await page
					.locator(SEL.songRow)
					.filter({ hasText: new RegExp(song, 'i') })
					.locator(SEL.singAction)
					.first()
					.click();
				await openQueue(page);
				await expect(page.locator(SEL.processing)).toHaveCount(1);
				await expect(ownCard(page)).toContainText(/\d+% · under a minute/, { timeout: 30_000 });
				// Later passes' cards sit below the earlier songs, under the fixed dock: bring this one to the middle.
				await ownCard(page).evaluate((el) => el.scrollIntoView({ block: 'center' }));
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			// The worker's next figure is the trigger; it lands within one `slowMs`. Waiting for it is what gives the
			// reduced pass's short burst a jump to show.
			trigger: async (page) => {
				const readout = ownCard(page).locator('.stage span:last-child');
				await expect(readout).not.toHaveText((await readout.textContent()) ?? '', { timeout: 8_000 });
			},
			only: '[data-slot="progress-indicator"]',
			// `open` leaves exactly one processing card, this pass's own, so the class names it.
			subject: SEL.processing,
			stripClip: async (page) => (await ownCard(page).boundingBox()) ?? undefined,
			observe: (page) =>
				page.evaluate(() => ({
					readout: document.querySelector('.proc .stage span:last-child')?.textContent?.trim() ?? null
				}))
		};
	},

	/** "Make this the TV", seen from the OLD TV mid-song: a second /tv claims the seat and the old TV's chip appears, as
	 *  a CUT. Each run seats a fresh old TV (claiming from it when the last run left the seat elsewhere) and opens a
	 *  fresh copy to tap from, with the long track playing (re-queued when it has ended). */
	'tv-copy-claim': (browser, world, cleanup) => {
		let phone: Page | undefined;
		let copy: Page | undefined;
		const tvAt = async (opts: BrowserContextOptions) => {
			const ctx = await browser.newContext({
				...opts,
				viewport: { width: 1920, height: 1080 },
				baseURL: world.baseURL
			});
			cleanup(() => ctx.close());
			const page = await ctx.newPage();
			// The server's first `tv:seat` answer, so "is this a copy?" is read after it is known, not raced.
			const seat = page
				.waitForEvent('websocket', { timeout: 30_000 })
				.then((ws) =>
					ws.waitForEvent('framereceived', {
						predicate: (f) => String(f.payload).includes('"tv:seat"'),
						timeout: 30_000
					})
				)
				.then((f) => (JSON.parse(String(f.payload)) as { mine: boolean }).mine);
			await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
			return { page, mine: await seat };
		};
		return {
			name: 'tv-copy-claim',
			what: 'TV 1920x1080 mid-song, the screen that IS the TV: a second /tv taps "Make this the TV", and this screen turns into the copy. Its chip appears as a CUT',
			stepMs: 33,
			scale: 0.5,
			columns: 5,
			startTimeoutMs: 1_500,
			open: async (opts) => {
				if (!phone) {
					const worker = await startFakeWorker(world, { seconds: LONG_TRACK.seconds });
					cleanup(() => worker.stop());
					phone = await world.openPhone('Ana');
					await readySong(world, phone, 'long');
				}
				if (!(await phone.locator(SEL.npStripTitle).count())) await queueReady(phone, 'long');
				await expect(phone.locator(SEL.npStripTitle)).toContainText(/long/i, { timeout: 30_000 });
				const old = await tvAt(opts);
				if (!old.mine) await old.page.getByRole('button', { name: 'Make this the TV' }).click();
				await expect(old.page.locator('.copy-chip')).toHaveCount(0);
				await expect(old.page.locator('.lower-third')).toContainText(/Ana/, { timeout: 30_000 });
				// Past the song-intro card, so the strip shows the chip and nothing else changing.
				await expect(old.page.locator(SEL.stateNext)).toHaveCount(0, { timeout: 15_000 });
				copy = (await tvAt(opts)).page;
				await expect(copy.locator('.copy-chip')).toBeVisible();
				return old.page;
			},
			trigger: async (page) => {
				await copy!.getByRole('button', { name: 'Make this the TV' }).click();
				await expect(page.locator('.copy-chip')).toBeVisible();
			},
			// The chip the old TV gains: on screen in every frame after the tap.
			subject: '.copy-chip',
			only: '.copy-chip, .copy-chip *'
		};
	},
	'tv-lyrics-fix': (browser, world, cleanup) => {
		let phone: Page | undefined;
		let tv: BrowserContext | undefined;
		cleanup(async () => tv?.close());
		let mediaId = '';
		let run = 0;
		const base = (i: number) => `line ${i} of the song`;
		const save = async (text: (i: number) => string) => {
			const audit = await (await phone!.request.get(`/api/audit/${mediaId}`)).json();
			const rev = (audit.media?.lyricsEditRev ?? 0) as number;
			const lines = Array.from({ length: 40 }, (_, i) => ({ text: text(i) }));
			const res = await phone!.request.post('/api/lyrics-edit', { data: { mediaId, rev, lines } });
			expect(res.status(), await res.text()).toBe(200);
		};
		return {
			name: 'tv-lyrics-fix',
			what: 'TV 1920x1080 mid-song: the host fixes two upcoming lines on their phone; at the next gap between lines those two rows fade in with the new words (lyrics-arrive, --motion-base, opacity only) and nothing else moves',
			stepMs: 33,
			scale: 0.5,
			columns: 5,
			startTimeoutMs: 12_000,
			open: async (opts) => {
				if (!phone) {
					const worker = await startFakeWorker(world, { seconds: LONG_TRACK.seconds });
					cleanup(() => worker.stop());
					phone = await world.openPhone('Ana');
					await world.becomeHost(phone);
					await readySong(world, phone, 'long');
					mediaId = (await world.awaitDemoTrack('long')).id;
				}
				if (!(await phone.locator(SEL.npStripTitle).count())) await queueReady(phone, 'long');
				// One TV at a time, so each run's screen is the TV and not a copy.
				await tv?.close();
				tv = await browser.newContext({ ...opts, viewport: { width: 1920, height: 1080 }, baseURL: world.baseURL });
				const page = await tv.newPage();
				const seat = page
					.waitForEvent('websocket', { timeout: 30_000 })
					.then((ws) =>
						ws.waitForEvent('framereceived', {
							predicate: (f) => String(f.payload).includes('"tv:seat"'),
							timeout: 30_000
						})
					)
					.then((f) => (JSON.parse(String(f.payload)) as { mine: boolean }).mine);
				await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
				// The last run's screen may still hold the seat for its grace; this one takes it.
				if (!(await seat)) await page.getByRole('button', { name: 'Make this the TV' }).click();
				await expect(page.locator('.copy-chip')).toHaveCount(0);
				await page.mouse.click(960, 540);
				await expect(page.locator(SEL.stateNext)).toHaveCount(0, { timeout: 30_000 });
				await save(base);
				await expect(page.locator(SEL.lyricsRowCurrent)).toContainText('of the song', { timeout: 20_000 });
				return page;
			},
			trigger: async (page) => {
				run++;
				const rows = page.locator(SEL.lyricsRow);
				const now = await rows.evaluateAll((els) => els.findIndex((el) => el.classList.contains('current')));
				// The two lines after next, so neither becomes the sung row inside the fade.
				await save((i) => (i === now + 2 || i === now + 3 ? `fixed words, take ${run}` : base(i)));
				// Delivered means on screen: the re-time and the wait for a gap come first, which Reduce Motion cannot see.
				await expect(page.locator('.lyrics .row.fresh').first()).toBeAttached({ timeout: 12_000 });
			},
			subject: '.lyrics .row.fresh',
			only: '.lyrics .row.fresh'
		};
	},
	'tv-chorus-cue': (browser, world, cleanup) => {
		let phone: Page | undefined;
		let tv: BrowserContext | undefined;
		cleanup(async () => tv?.close());
		const chorus = ['Sing it out loud', 'Everybody now', 'This one is ours'];
		return {
			name: 'tv-chorus-cue',
			what: 'TV 1920x1080 mid-song (proposal 38): on the line before the chorus, "Everyone" fades in over the row that opens it (opacity, --motion-base: 0.25 s), and the chorus rows are the room gold while the singer leads the wipe',
			stepMs: 33,
			scale: 0.5,
			columns: 5,
			startTimeoutMs: 12_000,
			open: async (opts) => {
				if (!phone) {
					const worker = await startFakeWorker(world, { seconds: ROOM_SCREEN_TRACK.seconds });
					cleanup(() => worker.stop());
					phone = await world.openPhone('Ana');
					await world.becomeHost(phone);
					await readySong(world, phone, 'room-screen');
					const mediaId = (await world.awaitDemoTrack('room-screen')).id;
					// Three verse lines then the chorus, on the fake worker's 0.8 s grid, for as long as the runs need.
					const lines = Array.from({ length: 200 }, (_, i) => ({
						text: i % 6 < 3 ? `Verse ${Math.floor(i / 6) + 1} line ${(i % 6) + 1}` : chorus[(i % 6) - 3]!
					}));
					const audit = await (await phone.request.get(`/api/audit/${mediaId}`)).json();
					const rev = (audit.media?.lyricsEditRev ?? 0) as number;
					const res = await phone.request.post('/api/lyrics-edit', { data: { mediaId, rev, lines } });
					expect(res.status(), await res.text()).toBe(200);
				}
				if (!(await phone.locator(SEL.npStripTitle).count())) await queueReady(phone, 'room-screen');
				await tv?.close();
				tv = await browser.newContext({ ...opts, viewport: { width: 1920, height: 1080 }, baseURL: world.baseURL });
				const page = await tv.newPage();
				const seat = page
					.waitForEvent('websocket', { timeout: 30_000 })
					.then((ws) =>
						ws.waitForEvent('framereceived', {
							predicate: (f) => String(f.payload).includes('"tv:seat"'),
							timeout: 30_000
						})
					)
					.then((f) => (JSON.parse(String(f.payload)) as { mine: boolean }).mine);
				await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
				// The last run's screen may still hold the seat for its grace; this one takes it.
				if (!(await seat)) await page.getByRole('button', { name: 'Make this the TV' }).click();
				await expect(page.locator('.copy-chip')).toHaveCount(0);
				await page.mouse.click(960, 540);
				// The last run paused on its cue.
				await sendPlayerCommand(phone, { cmd: 'play' });
				await expect(page.locator('.lyrics .row.chorus').first()).toBeAttached({ timeout: 30_000 });
				return page;
			},
			trigger: async (page) => {
				// The cue turns on as the line before a chorus starts; that edge is the trigger. The song pauses there, so
				// the line, and its cue, are still up while the frames are taken.
				await expect(page.locator('.lyrics .everyone.on')).toHaveCount(0, { timeout: 12_000 });
				await expect(page.locator('.lyrics .everyone.on')).toBeAttached({ timeout: 12_000 });
				await sendPlayerCommand(phone!, { cmd: 'pause' });
			},
			subject: '.lyrics .everyone.on',
			only: '.lyrics .everyone'
		};
	},
	'tv-song-intro': tvHandoff('in'),
	'tv-song-outro': tvHandoff('out'),
	'tv-lyrics-arrive': tvHandoff('arrive'),
	'tv-song-singer-change': tvHandoff('change'),

	/** The TV's reaction lane while two fans burst at the largest lyric scale: a stream of discs released 650 ms
	 *  apart up the right edge. A row about TIMING, so it also records in real time: once at 6× CPU, and once with
	 *  the first disc's first frame held 400 ms, which is #1000's bug and which the seek run cannot show (its timers
	 *  are held, so it seeks one disc). Each run opens its own TV on the same paused song. */
	'tv-reaction-lane': (browser, world, cleanup) => {
		let fans: Page[] | undefined;
		let lastBurst = 0;
		return {
			name: 'tv-reaction-lane',
			what: 'TV 1920x1080 @300% lyrics: two fans’ cheers rising up the lane as a stream, 650 ms apart from each disc’s first frame, clear of each other, the lyrics and the corner (rise, --rise-ms)',
			stepMs: 80,
			scale: 0.5,
			columns: 12,
			open: async (opts) => {
				if (!fans) {
					const room = await stage(world, 2);
					cleanup(() => room.worker.stop());
					await putRoom(room.star, { lyricsScalePct: MAX_LYRICS_SCALE_PCT });
					// Each run opens its own TV; this one would draw every disc a second time in the same browser.
					await room.tv.context().close();
					fans = room.fans;
				}
				const ctx = await browser.newContext({
					...opts,
					viewport: { width: 1920, height: 1080 },
					baseURL: world.baseURL
				});
				await ctx.addCookies([world.tvCookie]);
				const page = await ctx.newPage();
				await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
				await page.locator(SEL.tvConnected).waitFor({ state: 'attached' });
				await expect(page.locator(SEL.lyricsRow).first()).toBeAttached({ timeout: 25_000 });
				await page.mouse.move(1, 1);
				await page.evaluate(() => document.fonts.ready.then(() => true));
				await page.waitForTimeout(Math.max(0, lastBurst + BUCKET_REFILL_MS - Date.now()));
				return page;
			},
			trigger: async (page) => {
				lastBurst = Date.now();
				await burst(fans!);
				await page.locator(SEL.tvReaction).first().waitFor({ state: 'attached', timeout: 5_000 });
			},
			only: SEL.tvReaction,
			// The lane, not a disc: each disc fades out and is removed by design, the lane stays.
			subject: SEL.tvReactionLane,
			// The release timer would put more discs into a paused seek; held, it seeks one disc's rise.
			holdTimers: true,
			// The lane's right quarter of the screen.
			gifClip: async () => ({ x: 1440, y: 0, width: 480, height: 1080 }),
			// A suffix: the keyframe name before it carries Svelte's per-file hash.
			literalsAllowed: {
				match: 'var(--rise-ms) ease-out forwards is not a var(--motion-*) token',
				reason: 'the rise is RISE_MS in script, the number the release spacing is built on (tv/Reactions.svelte)'
			},
			realtime: {
				each: SEL.tvReaction,
				avoid: `.corner, ${SEL.lyricsRow}`,
				lateFirstFrameMs: 400,
				windowMs: 7_000
			}
		};
	}
};

/** The TV's "Now singing" card at a change of singer, which since #974 is every change, not only the first song.
 *  Ana sings caroline on this TV with Maya next (and Theo after, for `change`); Ana's skip hands the room to Maya
 *  and the card takes over the screen for the intro hold. Each run drains the room and starts Ana's song again, past
 *  her own card.
 *  - `in`: the card fading in as Ana skips, its lines rising into place.
 *  - `out`: the hold ending: the card fades out, starting --motion-base + --motion-fast before the hold ends.
 *  - `arrive`: the same moment, for the reel: once the card has gone the lyrics fade in, up when the song starts.
 *  - `change`: the room moves on to Theo while Maya's card is still coming up: only the lines rise again, and the
 *    layer (the scrim) never dips. */
function tvHandoff(phase: 'in' | 'out' | 'arrive' | 'change'): Make {
	return (browser, world, cleanup) => {
		let ana: Page | undefined;
		let maya: Page | undefined;
		let theo: Page | undefined;
		/** `change`: the entry Ana's probe socket named before her skip, so the trigger can wait for it to move on. */
		let anaEntry: string | null = null;
		const name = {
			in: 'tv-song-intro',
			out: 'tv-song-outro',
			arrive: 'tv-lyrics-arrive',
			change: 'tv-song-singer-change'
		}[phase];
		// `out` and `arrive` open the same way: Maya's card up at full.
		const exit = phase === 'out' || phase === 'arrive';
		const what = {
			in: 'TV 1920x1080: the "Now singing" card for Maya as Ana skips to her, the handoff on every change of singer: the layer fades in and the lines rise one --tv-space-4xl into place (--motion-slow, ease-out)',
			out: 'TV 1920x1080: the hold ending: Maya’s card fades out (--motion-base, ease, the player slots’ crossfade), starting --motion-base + --motion-fast before the hold ends so it has gone when her song starts; the words do not move. The edge progress line, hidden under the card, fades back in on the same curve (--motion-base, ease); the lower third cuts back in',
			arrive:
				'TV 1920x1080: once Maya’s card has gone, her lyrics fade in (lyrics-arrive, --motion-fast, ease-out, opacity only) in the hold’s last moment, so card text never draws over lyric text and the first line is readable when the song starts, as on main',
			change:
				'TV 1920x1080: the room moves on to Theo while Maya’s card is coming up: only the new lines rise in (--motion-slow); the layer’s opacity never drops (observed.layerOpacity)'
		}[phase];
		const layerOpacity = (page: Page) =>
			page.evaluate(() => {
				const el = document.querySelector('.takeover-layer');
				return el ? Number(getComputedStyle(el).opacity) : null;
			});
		return {
			name,
			what,
			stepMs: exit ? 16 : 33,
			scale: 0.5,
			columns: 5,
			startTimeoutMs: 1_500,
			open: async (opts) => {
				if (!ana || !maya || !theo) {
					// 36 s stems, so Ana's song is still on at the trigger however slowly the TV page opens. Real-length
					// lyric lines: with one word a line nothing can meet the card, so overlap 0 would mean nothing.
					const worker = await startFakeWorker(world, { seconds: LONG_TRACK.seconds, longLyricLines: true });
					cleanup(() => worker.stop());
					ana = await world.openPhone('Ana');
					maya = await world.openPhone('Maya');
					theo = await world.openPhone('Theo');
					await readySong(world, ana, 'caroline');
					await readySong(world, ana, 'believin');
				}
				// These rows are the suite's critical path (~45 s each, `liveMs` ~25 s): each of their 5 opens drains the
				// room (SETTLE_MS waits) and then waits out Ana's own "Now singing" card. The 36 s stems are not the cost;
				// shortening them lets Ana's song end before the trigger under load.
				await drain(ana);
				const ctx = await browser.newContext({
					...opts,
					viewport: { width: 1920, height: 1080 },
					baseURL: world.baseURL
				});
				await ctx.addCookies([world.tvCookie]);
				const page = await ctx.newPage();
				await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
				await expect(page.locator(SEL.lobby)).toBeVisible();
				await queueReady(ana, 'caroline');
				await queueReady(maya, 'believin');
				if (phase === 'change') await queueReady(theo, 'caroline');
				// Ana's own card comes and goes: the run opens on her song, with Maya next.
				await expect(page.locator(SEL.takeoverShown)).toHaveCount(1, { timeout: 30_000 });
				await expect(page.locator(SEL.stateNext)).toHaveCount(0, { timeout: 15_000 });
				await page.evaluate(() => document.fonts.ready.then(() => true));
				if (phase === 'in') return page;
				// The skip's socket opens now, so the `change` skip lands inside Maya's fade-in rather than after it.
				if (phase === 'change') {
					await sendPlayerCommand(ana, { cmd: 'play' });
					anaEntry = await ana.evaluate(() => (window as unknown as { probeCurrent?: string }).probeCurrent ?? null);
				}
				await transportTap(ana, 'skip');
				await expect(page.locator(SEL.stateNext)).toContainText('Maya', { timeout: 30_000 });
				// The exit's `before` frame is the card at full, not one still fading in: the name is in the page from the
				// card's first frame.
				if (exit) await expect.poll(() => layerOpacity(page)).toBe(1);
				return page;
			},
			trigger: async (page) => {
				if (phase === 'in') {
					await transportTap(ana!, 'skip');
					await expect(page.locator(SEL.takeoverShown)).toHaveCount(1, { timeout: 30_000 });
				} else if (phase === 'out') {
					// The hold's own clock is the trigger, as on a night: its exit lead drops the layer's `shown`.
					await expect(page.locator(SEL.takeoverShown)).toHaveCount(0, { timeout: 15_000 });
				} else if (phase === 'arrive') {
					// The same clock, then the reel mounting once the card has gone.
					await expect(page.locator(SEL.takeoverShown)).toHaveCount(0, { timeout: 15_000 });
					await page.locator(SEL.lyrics).waitFor({ state: 'attached', timeout: 10_000 });
				} else {
					// Names Maya's entry, the one the server says is current: no phone strip and no settle window. The probe
					// socket follows the server's `playback:state`, so under load it can still name Ana's song for a moment:
					// wait until it has moved on, or the skip is dropped as stale.
					await ana!.waitForFunction(
						(was) => {
							const now = (window as unknown as { probeCurrent?: string | null }).probeCurrent;
							return !!now && now !== was;
						},
						anaEntry,
						{ polling: 'raf', timeout: 10_000 }
					);
					await sendPlayerCommand(ana!, { cmd: 'skip' });
					await expect(page.locator(SEL.stateNext)).toContainText('Theo', { timeout: 30_000 });
				}
			},
			// `arrive` catches only the reel, so the card's exit runs live and the reel can mount: a caught (paused) exit
			// fade never ends, and the reel waits for it. One seek row cannot hold both: its caught set is fixed when
			// the trigger resolves.
			// The exit also catches the edge progress line the card hid, which fades back in with it (proposal 23); the
			// lower third cuts back, so it is not caught.
			only:
				phase === 'arrive'
					? SEL.lyrics
					: phase === 'out'
						? '.takeover-layer, .state-next, .state-next *, .edgebar'
						: '.takeover-layer, .state-next, .state-next *',
			// The exit's subject is the stage: the card ends at opacity 0 by design, and the lyrics come in only after it.
			subject: phase === 'out' ? SEL.tvRoot : phase === 'arrive' ? SEL.lyrics : '.state-next',
			// The card's intro hold is a wall-clock timeout (`interstitialTimer`, tv/+page.svelte): it would take the
			// card away between seeked frames. The exit's trigger is the hold's exit LEAD, --motion-base + --motion-fast
			// before the hold ends, so `out` holds it too. `arrive` catches the reel alone: the card's exit
			// runs live there, and the reel comes up once it has finished.
			holdTimers: phase !== 'arrive',
			// The card's lines against the corner card and the current line's words: they must never meet, nor two
			// cards' lines (a doubled card). Words, not `.row`: a row is a full-width block whose text is centred, so its
			// box meets the left-aligned card on every exit frame though no glyph does. shortcut: the other rows have
			// no text-tight box, so only the sung line is checked; give rows an inline wrapper if that ever matters.
			// The late run blocks the card's first frame, which the seek run cannot show. The probe
			// (tv-handoff-motion) checks every lyric row's text per frame; this pass checks the sung line's words.
			// EXCEPTION to UI checklist item 11 (blank 0), this row only, ruled in #1018's review by its CAUSE, not a
			// count: on `tv-song-singer-change`, blank frames are accepted only while the scrim is up and before Theo's
			// re-rise starts, with that delay (`firstFrameMs`) ≤ 200 ms at 6×. In the late run, blank frames inside the
			// tool's injected 400 ms stall are accepted if the scrim is up and Theo's rise starts within 100 ms of the
			// stall ending (`firstFrameMs` ≤ 500). Anything else blank is a fail. That is the
			// swap: Maya's lines unmount and Theo's mount at `card-rise`'s from-opacity 0, with the scrim up the whole time
			// (the probe pins that the layer never dips). Getting it to 0 would mean a doubled card or a rise that does
			// not start from 0. If a real TV shows it as a blink, give the rise a non-zero from-opacity.
			// `arrive` has none: the outro row's real-time window already runs through the reel's arrival.
			realtime:
				phase === 'arrive'
					? undefined
					: {
							each: '.state-next .up-label, .state-next .up-name, .state-next .up-song',
							avoid: '.corner, .lyrics .word',
							lateFirstFrameMs: 400,
							// The exit's trigger waits out the rest of the hold, which a 6× throttle stretches past a second.
							...(phase === 'out' ? { windowMs: 3_000 } : {})
						},
			observe: async (page) => ({
				cardText: await page.evaluate(() => document.querySelector('.state-next')?.textContent?.trim() ?? null),
				layerShown: (await page.locator(SEL.takeoverShown).count()) > 0,
				layerOpacity: await layerOpacity(page),
				lyrics: (await page.locator(SEL.lyrics).count()) > 0
			})
		};
	};
}

function register(name: string, make: Make) {
	// An anonymous describe per row, so a row's `test.use` reaches its own test and no other.
	test.describe(() => {
		// The tuple form: Playwright reads any array whose second item is an object as `[value, options]`.
		if (LIBRARY[name]) test.use({ demoLibrary: [LIBRARY[name], { scope: 'test' }] });
		if (CORE_ENV[name]) test.use({ coreEnv: CORE_ENV[name] });
		test(`motion ${name}`, async ({ browser, world }, testInfo) => {
			test.setTimeout(180_000);
			const cleanups: (() => Promise<unknown>)[] = [];
			const t = Date.now();
			try {
				const result = await captureMotion(
					browser,
					make(browser, world, (fn) => cleanups.push(fn)),
					// One fixed folder per row rather than Playwright's per-test dirs. Still under outputDir, so the next
					// Playwright run empties it: copy it out or set MOTION_OUT.
					process.env.MOTION_OUT ?? join(testInfo.project.outputDir, 'motion')
				);
				const declared = (result.metrics.declared as unknown[]).length;
				const tokens = result.metrics.tokens as { problems: string[] };
				testInfo.annotations.push({ type: 'motion', description: `${result.dir} in ${Date.now() - t} ms` });
				for (const [file, { path }] of Object.entries(result.files)) await testInfo.attach(file, { path });
				// The one thing this spec asserts: the capture saw what this row says is there.
				if (CUTS.has(name)) expect(declared, `${name}: motion appeared; take it out of CUTS`).toBe(0);
				else expect(declared, `${name}: no animation was caught after the trigger`).toBeGreaterThan(0);
				// Check 3 and the colour half of check 8: what the CSS authored, not what it measured.
				expect(tokens.problems, `${name}: literal durations, delays or colours`).toEqual([]);
				// Every frame after the trigger shows what the row is about; one that does not captured something else.
				expect(result.metrics.subject, `${name}: frames without the subject, in ms after the trigger`).toMatchObject({
					missingMs: { seek: [], reduced: [] }
				});
				// A real-time run that never saw what it measures, or a late run whose stall never ran, proves nothing.
				const realtime = (result.metrics.realtime ?? {}) as Record<string, RealtimeReport>;
				for (const [run, r] of Object.entries(realtime)) {
					expect(r.travelPx.each.length, `${name} ${run}: no \`each\` element was on screen`).toBeGreaterThan(0);
					// A throttled run whose busy loop did not slow down ran at full speed: it proves nothing about load.
					if (r.throttle > 1)
						expect(
							r.throttleRatio,
							`${name} ${run}: the ${r.throttle}× CPU throttle did not take`
						).toBeGreaterThanOrEqual(r.throttle / 3);
					if (run !== 'realtime-late') continue;
					expect(r.stall, `${name} ${run}: the stall never ran`).not.toBeNull();
					// A stall at the mount that did not make a first frame late did not hold the thread.
					if (r.stall!.at === 'mount')
						expect(r.firstFrameMs.worst, `${name} ${run}: no first frame was late`).toBeGreaterThanOrEqual(r.stall!.ms);
				}
				// The hold is the motion's whole point: "Trying again…" well after the pop and still at +1 s, then the room's
				// latest word. Live and under reduce. A filmstrip of the ack reverting at 112 ms used to pass this row.
				if (HELD[name]) {
					const m = result.metrics as { live: { observed: unknown }; reducedMotion: { observed: unknown } };
					expect(m.live.observed, `${name}: the hold (live)`).toMatchObject(HELD[name]);
					expect(m.reducedMotion.observed, `${name}: the hold (reduced)`).toMatchObject(HELD[name]);
				}
			} finally {
				for (const fn of cleanups) await fn();
			}
		});
	});
}

const isStory = (name: string) => name.startsWith('spotlight-');
// shortcut: one `vite dev` at a time keeps the story rows from reloading each other's pages (they share
// `.svelte-kit/`). Running the `spotlight` probe in the same invocation still starts a second one.
test.describe('spotlight story', () => {
	test.describe.configure({ mode: 'serial' });
	test.afterAll(async () => (await storyGallery)?.stop());
	for (const [name, make] of Object.entries(SCENARIOS)) if (isStory(name)) register(name, make);
});
for (const [name, make] of Object.entries(SCENARIOS)) if (!isStory(name)) register(name, make);
