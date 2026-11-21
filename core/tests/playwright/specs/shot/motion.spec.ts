// THE MOTION TABLE — the `shot` project's sibling for things that MOVE. A frame table (frames.spec.ts) proves a
// state at rest; this proves the trip between two states, as a GIF for a human and a ms-labelled filmstrip for
// an agent reviewer. Evidence, not assertions: like every `shot` spec it cannot fail a build on taste, only on
// the capture itself breaking (no motion caught where motion is expected, or motion caught where a cut is), and
// on a moving element whose duration, delay or colour is a literal instead of a token (`literalsAllowed` waives
// exactly one named literal, with a reason).
//
// `bun run ui:review` runs it; `-- -g <name>` runs one row. Output: tests/playwright/.artifacts/motion/<name>/,
// or MOTION_OUT/<name>/. What a reviewer checks against it is docs/UI-CHECKLIST.md.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openQueue, queueReady, readySong } from '../../world/actors';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';
import { captureMotion, type MotionScenario } from '../../world/motion';
import { DEMO_LIBRARY } from '../../world/seed';
import { join } from 'node:path';

/** `cleanup` runs after the capture, pass or fail: a row that starts a fake worker stops it there. */
type Make = (browser: Browser, world: World, cleanup: (fn: () => Promise<unknown>) => void) => MotionScenario;

/** Rows whose honest record today is a CUT: the capture must catch NO animation. Flip a row out of here in the
 *  PR that gives it motion, so the strip it makes is the before/after of that change. */
const CUTS = new Set(['tv-song-intro']);

/** A track longer than the 30 s heads-up window, so the on-deck row can cross it. The fixture's own are 8 s. */
const LONG_TRACK = { file: 'long-take.wav', seconds: 36, hz: [196, 246.94, 293.66] };
/** Rows that boot their core with more than the demo library. */
const LIBRARY: Record<string, typeof DEMO_LIBRARY> = { 'phone-on-deck-heads-up': [...DEMO_LIBRARY, LONG_TRACK] };

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

/** Drain the room, then Maya singing caroline past her intro card, with Theo next. */
async function mayaThenTheo(phones: { maya: Page; theo: Page; ana: Page }): Promise<void> {
	const { maya, theo, ana } = phones;
	const skip = ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first();
	for (let i = 0; i < 5 && (await skip.isVisible()); i++) {
		await skip.click();
		// Past the strip's settle window, so the next skip names the song now on it.
		await ana.waitForTimeout(1_200);
	}
	await expect(ana.locator(SEL.npStripTitle)).toHaveCount(0, { timeout: 10_000 });
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
			only: 'section.deck',
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

	/** The TV's "Now singing" card for the evening's first song. A phone queues a ready song into an idle room and
	 *  the TV takes over the screen with the card for the intro hold. Each run first skips the last run's song, so
	 *  it opens on an idle room again. */
	'tv-song-intro': (browser, world, cleanup) => {
		let phone: Page | undefined;
		return {
			name: 'tv-song-intro',
			what: 'TV 1920x1080: the "Now singing" card arriving for the first song: a CUT for the card itself (proposal 04 changes this). Behind it, the stage background and the player slot fade in over 250 ms; they are listed under live.others',
			stepMs: 33,
			scale: 0.5,
			columns: 5,
			startTimeoutMs: 1_500,
			open: async (opts) => {
				if (!phone) {
					const worker = await startFakeWorker(world);
					cleanup(() => worker.stop());
					phone = await world.openPhone('Ana');
					await readySong(world, phone, 'caroline');
				}
				const skip = phone.getByRole(SEL.skip.role, { name: SEL.skip.name }).first();
				if (await skip.isVisible()) await skip.click();
				await expect(phone.locator(SEL.npStripTitle)).toHaveCount(0);
				const ctx = await browser.newContext({
					...opts,
					viewport: { width: 1920, height: 1080 },
					baseURL: world.baseURL
				});
				const page = await ctx.newPage();
				await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
				// Ana has joined, so the idle TV is the lobby, not the attract screen.
				await expect(page.locator(SEL.lobby)).toBeVisible();
				await page.evaluate(() => document.fonts.ready.then(() => true));
				return page;
			},
			trigger: async (page) => {
				await queueReady(phone!, 'caroline');
				await expect(page.locator(SEL.stateNext)).toBeVisible({ timeout: 30_000 });
			},
			only: '.state-next, .state-next *',
			observe: (page) =>
				page.evaluate(() => ({ introText: document.querySelector('.state-next')?.textContent?.trim() ?? null }))
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
			} finally {
				for (const fn of cleanups) await fn();
			}
		});
	});
}
