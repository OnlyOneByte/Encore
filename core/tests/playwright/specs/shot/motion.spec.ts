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
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';
import { captureMotion, type MotionScenario } from '../../world/motion';
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
	'phone-reorder-held-390',
	'phone-reorder-held-320',
	'phone-cheers-return',
	'phone-dock-idle',
	'tv-copy-claim',
	'tv-copy-offline',
	'tv-copy-offline-390',
	'tv-copy-offline-320'
]);
/** What a dock CUT row is about: the strip's title and transport. Not the progress hairline, which glides once a
 *  second whenever a song plays (--motion-tick) and is not the change these rows record. */
const STRIP_CONTENT = '.dock .meta, .dock .meta *, .dock .tp, .dock .tp *';

/** A track longer than the 30 s heads-up window, so the on-deck row can cross it. The fixture's own are 8 s. */
const LONG_TRACK = { file: 'long-take.wav', seconds: 36, hz: [196, 246.94, 293.66] };
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
	'tv-copy-claim': [...DEMO_LIBRARY, LONG_TRACK],
	'tv-copy-offline': [...DEMO_LIBRARY, LONG_TRACK],
	'tv-copy-offline-390': [...DEMO_LIBRARY, LONG_TRACK],
	'tv-copy-offline-320': [...DEMO_LIBRARY, LONG_TRACK]
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
				await ph!.ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
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
 *  outside `only` (their literal 160/180/220 ms timings predate this row). The last row is whichever of Ana's two
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

/** Theo's /queue as the "Now singing" card comes (`arrive`: the room's first song) or goes (`leave`: that song
 *  skipped, nothing behind it). What is under the card is held where it was drawn and eases to its new place
 *  (`data-settle`, --motion-base), so nothing jumps. Arriving, the card then fades into the opened slot on the next
 *  --motion-base; leaving, it is a cut. Each run first puts the room in the state before. CLS in metrics.json also
 *  counts the fixed dock, whose top edge moves as the strip comes or goes: the root layout's. */
function queueCard(moment: 'arrive' | 'leave'): Make {
	return (browser, world, cleanup) => {
		let maya: Page | undefined;
		let theo: Page | undefined;
		const skip = () => maya!.getByRole(SEL.skip.role, { name: SEL.skip.name }).first();
		return {
			name: `phone-queue-card-${moment}`,
			what:
				moment === 'arrive'
					? 'Phone 390x844: /queue as the room’s first song starts — the empty state eases down from where it was (transform, --motion-base), then the "Now singing" card fades into the opened slot (opacity, --motion-base after --motion-base); no jump, never text over text'
					: 'Phone 390x844: /queue as the last song is skipped — the card goes at once (a cut) and the empty state eases up from where it was (transform, --motion-base), no jump',
			subject: moment === 'arrive' ? SEL.queueNowCard : 'main > .below',
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
				const playing = await skip().isVisible();
				if (moment === 'arrive' && playing) await skip().click();
				if (moment === 'leave' && !playing) await queueReady(maya, 'caroline');
				await expect(maya.locator(SEL.npStripTitle)).toHaveCount(moment === 'arrive' ? 0 : 1, { timeout: 10_000 });
				const page = await asSinger(browser, world, opts, theo);
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
			only: '.now, .below',
			stripClip: async () => ({ x: 0, y: 0, width: 390, height: 600 }),
			observe: (page) =>
				page.evaluate(() => ({
					card: !!document.querySelector('main > .now'),
					underTop: document.querySelector('main > .below')?.getBoundingClientRect().top ?? null
				}))
		};
	};
}

/** Theo's /queue at one phone width as his own song starts (proposal 18): his On deck card goes (a cut) and the
 *  "Queued" heading and the rows under it ease up from where they were drawn (`data-hold`, transform, --motion-base),
 *  once, though the list changes in two patches 12 ms apart. Under reduced motion it is a cut. Each run first drains
 *  the room and queues Maya, Theo, Ana, Maya again. */
function queueYourSong(width: number): Make {
	return (browser, world, cleanup) => {
		let ph: { maya: Page; theo: Page; ana: Page } | undefined;
		const DECK = 'section[aria-label="On deck"]';
		return {
			name: `phone-queue-your-song-${width}`,
			what: `Phone ${width}x844: /queue as Theo’s own song starts — the On deck card goes (a cut) and the heading and rows ease up into its place (transform, --motion-base), one glide and no jump; a cut under reduced motion`,
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
				await ph!.maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
				await page.locator(DECK).waitFor({ state: 'detached', timeout: 10_000 });
			},
			// `.youre-up` too: the sheet rises over the dock in the same moment, so a capture without it froze it mid-fade.
			only: 'main .grouphead, main .qrow, .youre-up',
			// The rule the hold outranks, not its timing: a row also matches app.css's `.pop-in` (its entrance, 0.22s).
			literalsAllowed: { match: 'literal timing 0.22s', reason: 'QueueRow’s .pop-in entrance, outranked by the hold' },
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
				await maya.locator(SEL.searchSource).first().selectOption('local');
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

/** A copy mid-song as the room's TV drops (proposal 19): its chip's line turns from "Another screen is the TV" to
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
				await expect(page.locator('.copy-chip')).toContainText('Another screen is the TV', { timeout: 15_000 });
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
				page.evaluate(() => ({ chip: document.querySelector('.copy-chip')?.textContent?.trim() ?? null }))
		};
	};
}

const SCENARIOS: Record<string, Make> = {
	'tv-copy-offline': tvCopyOffline(1920, 1080),
	'tv-copy-offline-390': tvCopyOffline(390, 844),
	'tv-copy-offline-320': tvCopyOffline(320, 568),
	'phone-queue-card-arrive': queueCard('arrive'),
	'phone-queue-card-leave': queueCard('leave'),
	'phone-queue-your-song-390': queueYourSong(390),
	'phone-queue-your-song-320': queueYourSong(320),
	'phone-dock-your-song-390': dockYourSong(390),
	'phone-dock-your-song-320': dockYourSong(320),
	'phone-reorder-held-390': reorderHeld(390),
	'phone-reorder-held-320': reorderHeld(320),
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
	/** ✕ gives the strip back to the transport: a cut, the same height. */
	'phone-cheers-return': fanDock(
		'phone-cheers-return',
		'Phone 390x844: ✕ on the tray — the title and transport come back, a cut at the same height',
		{
			cheering: true,
			trigger: async (page) => {
				await page.locator(SEL.npCheersClose).click();
				await page.locator(SEL.npPlayPause).waitFor({ state: 'attached', timeout: 5_000 });
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
				await page.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
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
				await page.context().setOffline(true);
				await page.locator(SEL.npStripOffline).waitFor({ state: 'attached', timeout: 15_000 });
			},
			only: '.dock .cheer-key',
			subject: SEL.npStrip
		}
	),
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
			out: 'TV 1920x1080: the hold ending: Maya’s card fades out (--motion-base, ease, the player slots’ crossfade), starting --motion-base + --motion-fast before the hold ends so it has gone when her song starts; the words do not move',
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
				await ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
				await expect(page.locator(SEL.stateNext)).toContainText('Maya', { timeout: 30_000 });
				// The exit's `before` frame is the card at full, not one still fading in: the name is in the page from the
				// card's first frame.
				if (exit) await expect.poll(() => layerOpacity(page)).toBe(1);
				return page;
			},
			trigger: async (page) => {
				if (phase === 'in') {
					await ana!.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
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
			only: phase === 'arrive' ? SEL.lyrics : '.takeover-layer, .state-next, .state-next *',
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

for (const [name, make] of Object.entries(SCENARIOS)) {
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
