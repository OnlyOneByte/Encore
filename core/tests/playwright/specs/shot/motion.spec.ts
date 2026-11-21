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
import { openBrowseFromHome, openQueue, queueReady, readySong } from '../../world/actors';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';
import { captureMotion, type MotionScenario, type RealtimeReport } from '../../world/motion';
import { burst, putRoom, stage } from '../../world/reactions';
import { DEMO_LIBRARY } from '../../world/seed';
import { join } from 'node:path';
import { SETTLE_MS } from '$lib/transport-target';
import { MAX_LYRICS_SCALE_PCT } from '$lib/contract';

/** `cleanup` runs after the capture, pass or fail: a row that starts a fake worker stops it there. */
type Make = (browser: Browser, world: World, cleanup: (fn: () => Promise<unknown>) => void) => MotionScenario;

/** Rows whose honest record today is a CUT: the capture must catch NO animation. Flip a row out of here in the
 *  PR that gives it motion, so the strip it makes is the before/after of that change. */
const CUTS = new Set(['tv-song-intro']);

/** A track longer than the 30 s heads-up window, so the on-deck row can cross it. The fixture's own are 8 s. */
const LONG_TRACK = { file: 'long-take.wav', seconds: 36, hz: [196, 246.94, 293.66] };
/** Two more songs, so each of the bar row's five pages (seek, three live, reduced) makes a song of its own. */
const BAR_TRACKS = [
	{ file: 'open-road.wav', seconds: 8, hz: [196, 246.94, 293.66] },
	{ file: 'night-drive.wav', seconds: 8, hz: [220, 261.63, 329.63] }
];
/** Rows that boot their core with more than the demo library. */
const LIBRARY: Record<string, typeof DEMO_LIBRARY> = {
	'phone-on-deck-heads-up': [...DEMO_LIBRARY, LONG_TRACK],
	'phone-processing-bar': [...DEMO_LIBRARY, ...BAR_TRACKS]
};

/** How long a fan's reaction bucket takes to refill after a burst (the reaction probe's wait), so every run's burst
 *  sends as many as the first one did. */
const BUCKET_REFILL_MS = 3_200;

let joins = 0;

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

/** Skip whatever is on until the room is empty. Each skip waits past the strip's settle window (SETTLE_MS, #974),
 *  so the next skip names the song now on it. */
async function drain(phone: Page): Promise<void> {
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

/** The dock as the song becomes yours, at one phone width: the reaction row's buttons fade out IN PLACE (opacity,
 *  --motion-base) and the row keeps its slot, so the dock does not move. "You're up" rises over it in the same
 *  moment and is listed under live.others. CLS must read 0 in metrics.json. */
function dockYourSong(width: number): Make {
	return (browser, world, cleanup) => {
		let ph: { maya: Page; theo: Page; ana: Page } | undefined;
		return {
			name: `phone-dock-your-song-${width}`,
			what: `Phone ${width}x844: the dock as Theo’s song starts — the cheer buttons fade out in place (opacity, --motion-base), the row keeps its height, the dock does not move (CLS 0)`,
			stepMs: 33,
			scale: 1,
			columns: 5,
			open: async (opts) => {
				if (!ph) {
					const worker = await startFakeWorker(world);
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
				const page = await asSinger(browser, world, opts, ph.theo, width);
				await page.goto('/');
				await expect(page.locator(SEL.npStripTitle)).toContainText(/caroline/i);
				await expect(page.locator(SEL.npCheer).first()).toBeVisible();
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				await ph!.ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
				await page.locator(`${SEL.npCheers}[inert]`).waitFor({ state: 'attached', timeout: 5_000 });
			},
			only: '.cheer',
			// The cheer row, not its buttons: they fade to opacity 0 by design, while the row keeps its height and
			// opacity. A collapsed or removed row fails here; the whole dock would not.
			subject: SEL.npCheers,
			stripClip: async () => ({ x: 0, y: 604, width, height: 240 }),
			observe: (page) =>
				page.evaluate(() => {
					const r = document.querySelector('.dock')!.getBoundingClientRect();
					return {
						dock: { y: r.y, h: r.height },
						rowInert: document.querySelector('.dock .cheers')?.hasAttribute('inert') ?? null
					};
				})
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

const SCENARIOS: Record<string, Make> = {
	'phone-dock-your-song-390': dockYourSong(390),
	'phone-dock-your-song-320': dockYourSong(320),
	/** "You're up" rising over the dock on Theo's Library tab as a skip makes his song start (`.rise-in`). Each run
	 *  drains the room and starts again from Maya's song. */
	'phone-youre-up': (browser, world, cleanup) => {
		let ph: { maya: Page; theo: Page; ana: Page } | undefined;
		return {
			name: 'phone-youre-up',
			what: 'Phone 390x844: "You’re up" rising over the dock on the Library tab as Theo’s song starts (rise-in, --motion-base)',
			stepMs: 16,
			scale: 1,
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
				await ph!.ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
				await page.locator('.youre-up').waitFor({ state: 'attached', timeout: 5_000 });
			},
			only: '.youre-up',
			subject: '.youre-up',
			// The sheet's wall-clock dismiss (`youreUpTimer`, +layout.svelte) would otherwise fire between seeked frames.
			holdTimers: true,
			// The dock and the sheet over it: the whole page in ~16 frames is past 2000 px tall.
			stripClip: async () => ({ x: 0, y: 444, width: 390, height: 400 }),
			observe: (page) =>
				page.evaluate(() => ({
					sheet: !!document.querySelector('.youre-up'),
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
			reason: 'a slower swap for a screen nobody is acting on (tv/+page.svelte)'
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

	/** On deck crossing into the heads-up, for real: Theo sings a 36 s track on a real TV, so Maya's card starts as
	 *  "On deck" with its time-left and, 30 s from the end, becomes "You’re next": the class, the eyebrow text and
	 *  the time-left all change in one update, and the card fades to her colour (--motion-slow). Each run restarts
	 *  Theo's song so it opens before the crossing. Needs the long track in this file's library (`LIBRARY`). */
	'phone-on-deck-heads-up': (browser, world, cleanup) => {
		let theo: Page | undefined;
		let maya: Page | undefined;
		return {
			name: 'phone-on-deck-heads-up',
			what: 'Phone 390x844: the on-deck card crossing 30 s left on a real 36 s song — "On deck" + time-left → "You’re next", fading to the singer colour (--motion-slow)',
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
				await theo.getByRole(SEL.restart.role, { name: SEL.restart.name }).first().click();
				const page = await asSinger(browser, world, opts, maya);
				await page.goto('/');
				await openQueue(page);
				await page.locator('section.deck:not(.heads-up) .left').waitFor();
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			// The song's own clock is the trigger, as on a night.
			trigger: (page) => page.locator('section.deck.heads-up').waitFor({ timeout: 20_000 }),
			// The card AND its children: the eyebrow's ink fades on its own transition, which `section.deck` alone files
			// under `others` and never seeks.
			only: 'section.deck, section.deck *',
			subject: 'section.deck.heads-up',
			// The card and a little of what is around it: the whole 390x844 page in 15 frames is past 2000 px tall.
			stripClip: async (page) => {
				const box = await page.locator('section.deck').boundingBox();
				return box ? { x: 0, y: Math.max(0, box.y - 12), width: 390, height: box.height + 24 } : undefined;
			},
			observe: (page) =>
				page.evaluate(() => ({
					headsUp: !!document.querySelector('section.deck.heads-up'),
					eyebrow: document.querySelector('section.deck .eyebrow')?.textContent?.trim() ?? null,
					timeLeftShown: !!document.querySelector('section.deck .left')
				}))
		};
	},

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

	/** The TV's "Now singing" card at a change of singer, which since #974 is every change, not only the first
	 *  song. Ana sings caroline on this TV with Maya next; Ana's skip hands the room to Maya and the card takes over
	 *  the screen for the intro hold. Each run drains the room and starts Ana's song again, past her own card. */
	'tv-song-intro': (browser, world, cleanup) => {
		let ana: Page | undefined;
		let maya: Page | undefined;
		return {
			name: 'tv-song-intro',
			what: 'TV 1920x1080: the "Now singing" card for Maya as Ana skips to her, the handoff on every change of singer: a CUT, in and out, for the card itself. Behind it, whatever fades is listed under live.others',
			stepMs: 33,
			scale: 0.5,
			columns: 5,
			startTimeoutMs: 1_500,
			open: async (opts) => {
				if (!ana || !maya) {
					// 36 s stems, so Ana's song is still on at the trigger however slowly the TV page opens.
					const worker = await startFakeWorker(world, { seconds: LONG_TRACK.seconds });
					cleanup(() => worker.stop());
					ana = await world.openPhone('Ana');
					maya = await world.openPhone('Maya');
					await readySong(world, ana, 'caroline');
					await readySong(world, ana, 'believin');
				}
				// This row is the suite's critical path (~45 s, `liveMs` ~25 s): each of its 5 opens drains the room
				// (SETTLE_MS waits) and then waits out Ana's own "Now singing" card. The 36 s stems are not the cost;
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
				// Ana's own card comes and goes: the run opens on her song, with Maya next.
				await expect(page.locator(SEL.stateNext)).toBeVisible({ timeout: 30_000 });
				await expect(page.locator(SEL.stateNext)).toHaveCount(0, { timeout: 15_000 });
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				await ana!.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
				await expect(page.locator(SEL.stateNext)).toBeVisible({ timeout: 30_000 });
			},
			only: '.state-next, .state-next *',
			subject: '.state-next',
			// The card's intro hold is a wall-clock timeout (`interstitialTimer`, tv/+page.svelte): it would take the
			// CUT's after frame away.
			holdTimers: true,
			observe: (page) =>
				page.evaluate(() => ({ introText: document.querySelector('.state-next')?.textContent?.trim() ?? null }))
		};
	},

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

for (const [name, make] of Object.entries(SCENARIOS)) {
	// An anonymous describe per row, so a row's `test.use` reaches its own test and no other.
	test.describe(() => {
		// The tuple form: Playwright reads any array whose second item is an object as `[value, options]`.
		if (LIBRARY[name]) test.use({ demoLibrary: [LIBRARY[name], { scope: 'test' }] });
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
					if (run === 'realtime-late') expect(r.stall, `${name} ${run}: the stall never ran`).not.toBeNull();
				}
			} finally {
				for (const fn of cleanups) await fn();
			}
		});
	});
}
