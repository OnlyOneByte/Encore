// THE MOTION TABLE — the `shot` project's sibling for things that MOVE. A frame table (frames.spec.ts) proves a
// state at rest; this proves the trip between two states, as a GIF for a human and a ms-labelled filmstrip for
// an agent reviewer. Evidence, not assertions: like every `shot` spec it cannot fail a build on taste, only on
// the capture itself breaking (no motion caught where motion is expected, or motion caught where a cut is).
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
import { join } from 'node:path';

/** `cleanup` runs after the capture, pass or fail: a row that starts a fake worker stops it there. */
type Make = (browser: Browser, world: World, cleanup: (fn: () => Promise<unknown>) => void) => MotionScenario;

/** Rows whose honest record today is a CUT: the capture must catch NO animation. Flip a row out of here in the
 *  PR that gives it motion, so the strip it makes is the before/after of that change. */
const CUTS = new Set(['tv-song-intro']);

let joins = 0;

/** A fresh context that is already this phone's singer, so each of the three runs gets its own page. */
async function asSinger(browser: Browser, world: World, opts: BrowserContextOptions, state: Page): Promise<Page> {
	const ctx = await browser.newContext({
		...opts,
		viewport: { width: 390, height: 844 },
		baseURL: world.baseURL,
		storageState: await state.context().storageState()
	});
	return ctx.newPage();
}

const SCENARIOS: Record<string, Make> = {
	/** The attract phrase swap: `{#key attractPhrase}` remounts the line and `phrase-fade` plays, every 8 s. */
	'tv-attract-phrase': (browser, world) => ({
		name: 'tv-attract-phrase',
		what: 'TV attract screen: the headline phrase rotating (phrase-fade, 0.6s ease-out, every 8s)',
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

	/** On deck turning into the heads-up: the card fades to the singer's colour (--motion-slow). The fixture tracks
	 *  are 8 s, so the live card is ALWAYS inside the 30 s window and never crosses into it on its own. The row
	 *  therefore takes the shipped `heads-up` class off the real card, lets it settle, and puts it back: the shipped
	 *  CSS doing the shipped transition, on the real page. No TV is in the room, so the song never advances. */
	'phone-on-deck-heads-up': (browser, world, cleanup) => {
		let maya: Page | undefined;
		return {
			name: 'phone-on-deck-heads-up',
			what: 'Phone 390x844: the on-deck card turning into "You’re next" (background + border to the singer colour, --motion-slow)',
			stepMs: 33,
			scale: 1,
			columns: 5,
			open: async (opts) => {
				if (!maya) {
					const worker = await startFakeWorker(world);
					cleanup(() => worker.stop());
					const theo = await world.openPhone('Theo');
					maya = await world.openPhone('Maya', { stop: 'End' });
					await readySong(world, theo, 'believin');
					await readySong(world, theo, 'caroline');
					await queueReady(theo, 'believin');
					await expect(theo.locator(SEL.npStripTitle)).toBeAttached();
					await queueReady(maya, 'caroline');
				}
				const page = await asSinger(browser, world, opts, maya);
				await page.goto('/');
				await openQueue(page);
				const deck = page.locator('section.deck.heads-up');
				await deck.waitFor();
				await page.evaluate(() => document.fonts.ready.then(() => true));
				await deck.evaluate((el) => el.classList.remove('heads-up'));
				// Past the way back (400 ms), so the caught transition is the one INTO the heads-up.
				await page.waitForTimeout(600);
				return page;
			},
			trigger: (page) => page.locator('section.deck').evaluate((el) => el.classList.add('heads-up')),
			only: 'section.deck',
			// The card and a little of what is around it: the whole 390x844 page in 15 frames is past 2000 px tall.
			stripClip: async (page) => {
				const box = await page.locator('section.deck').boundingBox();
				return box ? { x: 0, y: Math.max(0, box.y - 12), width: 390, height: box.height + 24 } : undefined;
			},
			observe: (page) => page.evaluate(() => ({ headsUp: !!document.querySelector('section.deck.heads-up') }))
		};
	},

	/** The TV's "Now singing" card for the evening's first song. A phone queues a ready song into an idle room and
	 *  the TV takes over the screen with the card for the intro hold. Each run first skips the last run's song, so
	 *  it opens on an idle room again. */
	'tv-song-intro': (browser, world, cleanup) => {
		let phone: Page | undefined;
		return {
			name: 'tv-song-intro',
			what: 'TV 1920x1080: the "Now singing" card arriving for the first song (proposal 04 changes this moment)',
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
	test(`motion ${name}`, async ({ browser, world }, testInfo) => {
		test.setTimeout(180_000);
		const cleanups: (() => Promise<unknown>)[] = [];
		const t = Date.now();
		try {
			const result = await captureMotion(
				browser,
				make(browser, world, (fn) => cleanups.push(fn)),
				// A stable path to point a reviewer at, not the per-test dir Playwright wipes on the next run.
				process.env.MOTION_OUT ?? join(testInfo.project.outputDir, 'motion')
			);
			const declared = (result.metrics.declared as unknown[]).length;
			testInfo.annotations.push({ type: 'motion', description: `${result.dir} in ${Date.now() - t} ms` });
			for (const [file, { path }] of Object.entries(result.files)) await testInfo.attach(file, { path });
			// The one thing this spec asserts: the capture saw what this row says is there.
			if (CUTS.has(name)) expect(declared, `${name}: motion appeared; take it out of CUTS`).toBe(0);
			else expect(declared, `${name}: no animation was caught after the trigger`).toBeGreaterThan(0);
		} finally {
			for (const fn of cleanups) await fn();
		}
	});
}
