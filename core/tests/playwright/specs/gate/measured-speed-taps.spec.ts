// CLAIM 10 tap to first change <= 100 ms, 11 CLS 0 on the phone session, 12 no flash on a Sing search, 14 phone
// motion <= 400 ms. Method: docs/E2E.md#speed-gate.
import type { Page } from '@playwright/test';
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { DEMO_LIBRARY } from '../../world/seed';
import { startFakeWorker } from '../../world/workers';
import { openQueue, queueReady, readySong } from '../../world/actors';
import { best, flashes, instrument, readState, report, tapToChange, throttle, type Anim } from './speed-measure';

const BUDGET_MS = 100;
const REPS = 5;
const ON_DECK = 'section[aria-label="On deck"]';
const MOTION_MAX_MS = 400;

/** The labels name the song, as on-deck-hold matches them. */
const keyName = (i: number) => (i % 2 ? /^Raise .+ by one semitone$/ : /^Lower .+ by one semitone$/);

const SECS = 120;
test.use({ demoLibrary: [DEMO_LIBRARY.map((t) => ({ ...t, seconds: SECS })), { scope: 'test' }] });

/** 1x best-of-N is gated; 4x is reported. */
async function measure(
	page: Page,
	lines: string[],
	name: string,
	root: string,
	tap: (i: number) => Promise<void>,
	settle: (i: number) => Promise<void>
) {
	// One count across both passes, so an alternating control (key down, up) keeps alternating.
	let n = 0;
	for (const cpu of [1, 4]) {
		if (cpu === 4) await throttle(page, 4);
		const ms: number[] = [];
		for (let i = 0; i < (cpu === 1 ? REPS : 3); i++, n++) {
			const k = n;
			ms.push(await tapToChange(page, root, () => tap(k)));
			await settle(k);
		}
		if (cpu === 4) await throttle(page, 1);
		if (cpu === 1) {
			lines.push(report(`CLAIM 10 ${name}`, ms, BUDGET_MS));
			expect
				.soft(best(ms), `CLAIM 10 ${name}: best of ${ms.map(Math.round).join(', ')} ms`)
				.toBeLessThanOrEqual(BUDGET_MS);
		} else lines.push(report(`CLAIM 10 REPORTED ONLY ${name}, CPU 4x`, ms, BUDGET_MS));
	}
}

/** Loops are indicators, and the strip's fill moves on --motion-tick by design: neither is tenet 3 motion. */
const ruled = (a: Anim) => a.iterations === Infinity || /^DIV\.fill /.test(a.what);
const tooLong = (anims: Anim[]) => anims.filter((a) => !ruled(a) && a.duration + a.delay > MOTION_MAX_MS);
/** The Now card's `arrive` is gated in its own known-break test. */
const notNowCard = (a: Anim) => !/arrive/.test(a.name);

async function still(page: Page, phase: string, { shifts = true } = {}) {
	const s = await readState(page);
	if (shifts) expect.soft(s.cls, `CLAIM 11 layout shifts on the phone ${phase}: ${JSON.stringify(s.shifts)}`).toBe(0);
	const long = tooLong(s.anims).filter(notNowCard);
	expect.soft(long, `CLAIM 14 animations past ${MOTION_MAX_MS} ms on the phone ${phase}`).toEqual([]);
}

test('CLAIM 10 / 11 / 14 Sing (+), the tabs and On deck answer in the next frame, shift nothing, move briefly', async ({
	world
}) => {
	test.setTimeout(300_000);
	const worker = await startFakeWorker(world, { seconds: SECS });
	const lines: string[] = [];
	try {
		const maya = await world.openPhone('Maya');
		const ben = await world.openPhone('Ben');
		for (const q of ['caroline', 'believin', 'prayer']) await readySong(world, maya, q);
		const tv = await world.openTv();
		await queueReady(maya, 'caroline');
		await expect(tv.locator(SEL.stateNext)).toBeHidden({ timeout: 30_000 });
		await ben.goto('/?source=local');
		await instrument(ben);

		// Each add is taken back on Ben's own /queue in a second tab, so every rep starts clean.
		const benQ = await ben.context().newPage();
		await benQ.goto('/queue');
		await ben.locator(SEL.search).fill('believin');
		const row = ben.locator(SEL.songRow, { hasText: 'believin' }).first();
		await row.evaluate((el) => el.setAttribute('data-sg', 'row'));
		const add = row.locator(SEL.addAction);
		await expect(add).toBeVisible();
		await measure(
			ben,
			lines,
			'Sing (+) on a ready song',
			'[data-sg=row]',
			() => add.click(),
			async () => {
				await expect(add).toHaveAttribute('aria-disabled', 'true');
				await benQ
					.locator(SEL.queueRow, { hasText: /believin/i })
					.locator(SEL.queueRemove)
					.first()
					.click();
				await expect(add).not.toHaveAttribute('aria-disabled', 'true');
			}
		);
		await benQ.close();

		const order = ['Library', 'Queue', 'Sing'];
		await measure(
			ben,
			lines,
			'a dock tab',
			'.tabs',
			(i) =>
				ben
					.locator(SEL.tab)
					.filter({ hasText: order[i % 3] })
					.first()
					.click(),
			(i) => expect(ben.locator('.tabs [aria-current="page"]')).toContainText(order[i % 3]!)
		);
		// Before the goto below: a new document starts a new record.
		await still(ben, 'while adding and switching tabs');

		await ben.goto('/');
		await queueReady(ben, 'prayer');
		await openQueue(ben);
		const deck = ben.locator(ON_DECK);
		await expect(deck).toBeVisible({ timeout: 10_000 });
		// The key's own steps are the known break below.
		await still(ben, 'opening /queue with the On deck card');
		await measure(
			ben,
			lines,
			'an On deck key',
			ON_DECK,
			(i) => deck.getByRole('button', { name: keyName(i) }).click(),
			(i) => (i % 2 ? expect(deck).not.toContainText('−1') : expect(deck).toContainText('−1'))
		);

		await still(ben, 'stepping the On deck key', { shifts: false });
	} finally {
		console.log(lines.join('\n'));
		await test.info().attach('speed-taps.txt', { body: lines.join('\n'), contentType: 'text/plain' });
		await worker.stop();
	}
});

test('CLAIM 11 an On deck key step shifts nothing', async ({ world }) => {
	const worker = await startFakeWorker(world, { seconds: SECS });
	try {
		const maya = await world.openPhone('Maya');
		const ben = await world.openPhone('Ben');
		for (const q of ['caroline', 'prayer']) await readySong(world, maya, q);
		await queueReady(maya, 'caroline');
		await ben.goto('/?source=local');
		await queueReady(ben, 'prayer');
		await openQueue(ben);
		const deck = ben.locator(ON_DECK);
		await expect(deck).toBeVisible({ timeout: 10_000 });
		await instrument(ben);
		for (let i = 0; i < 4; i++) {
			await deck.getByRole('button', { name: keyName(i) }).click();
			await (i % 2 ? expect(deck).not.toContainText('−1') : expect(deck).toContainText('−1'));
		}
		await ben.waitForTimeout(600);
		const s = await readState(ben);
		expect(s.cls, `CLAIM 11 layout shifts stepping the On deck key: ${JSON.stringify(s.shifts)}`).toBe(0);
	} finally {
		await worker.stop();
	}
});

test('CLAIM 10 Try again answers in the next frame', async ({ world }) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world, { fail: 'stems' });
	const lines: string[] = [];
	try {
		const maya = await world.openPhone('Maya');
		const track = await world.awaitDemoTrack('caroline');
		await maya.goto('/?source=local');
		await maya.locator(SEL.search).fill(track.title);
		await maya.locator(SEL.songRow).first().locator(SEL.singAction).click();
		await openQueue(maya);
		const retry = maya.locator(`${SEL.processing} [data-testid="card-retry"]`);
		await expect(retry).toBeEnabled({ timeout: 30_000 });
		await instrument(maya);
		await measure(
			maya,
			lines,
			'Try again on a failed song',
			SEL.processing,
			() => retry.click(),
			// Past the ruled 1.5 s hold and the worker's next failure.
			() => expect(retry).toBeEnabled({ timeout: 15_000 })
		);
	} finally {
		console.log(lines.join('\n'));
		await test.info().attach('speed-try-again.txt', { body: lines.join('\n'), contentType: 'text/plain' });
		await worker.stop();
	}
});

// One test per indicator that used to flash (#1091, #1126).
const SEARCH_FLASHES = [
	{ name: 'the "Searching…" skeleton rows', match: /^DIV\.skels / },
	{ name: 'the search field\'s "Searching" spinner', match: /^SPAN\.encore-spinner / }
];
async function searchFlashes(world: World) {
	const track = await world.awaitDemoTrack('caroline');
	const ben = await world.openPhone('Ben');
	await ben.goto('/?source=local');
	await instrument(ben);
	// When result rows appear: a skeleton that real rows replace is not a flash (owner ruling on #1171).
	await ben.evaluate(() => {
		const w = window as unknown as { rowsAt: number[] };
		w.rowsAt = [];
		let had = false;
		new MutationObserver(() => {
			const has = !!document.querySelector('.row');
			if (has && !had) w.rowsAt.push(performance.timeOrigin + performance.now());
			had = has;
		}).observe(document, { subtree: true, childList: true });
	});
	for (let i = 0; i < 3; i++) {
		if (await ben.locator(SEL.clearSearch).count()) await ben.locator(SEL.clearSearch).first().click();
		await ben.locator(SEL.search).fill(track.title);
		await expect(ben.locator(SEL.songRow).first()).toBeVisible();
	}
	await ben.waitForTimeout(400);
	const rowsAt = await ben.evaluate(() => (window as unknown as { rowsAt: number[] }).rowsAt);
	const replaced = (end: number | null) => end !== null && rowsAt.some((t) => Math.abs(t - end) < 50);
	return flashes((await readState(ben)).indicators).filter(
		(i) => !(SEARCH_FLASHES[0]!.match.test(i.what) && replaced(i.end))
	);
}

for (const flash of SEARCH_FLASHES) {
	test(`CLAIM 12 a Sing search shows no flash of ${flash.name}`, async ({ world }) => {
		const f = (await searchFlashes(world)).filter((i) => flash.match.test(i.what));
		expect(f, `CLAIM 12 ${flash.name} flashed for under 300 ms while searching`).toEqual([]);
	});
}

test('CLAIM 12 a Sing search flashes no other indicator', async ({ world }) => {
	const other = (await searchFlashes(world)).filter((i) => !SEARCH_FLASHES.some((s) => s.match.test(i.what)));
	expect(other, 'CLAIM 12 an unexpected indicator flashed for under 300 ms while searching').toEqual([]);
});

test('CLAIM 14 the /queue Now card arrives within 400 ms (#1092)', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		await readySong(world, maya, 'caroline');
		await openQueue(theo);
		await instrument(theo);
		await queueReady(maya, 'caroline');
		await expect(theo.locator(SEL.queueNowCard)).toContainText(/caroline/i, { timeout: 10_000 });
		await theo.waitForTimeout(800);
		const arrive = (await readState(theo)).anims.filter((a) => /arrive/.test(a.name));
		expect(arrive.length, 'the Now card ran no `arrive` animation to measure').toBeGreaterThan(0);
		expect(tooLong(arrive), `CLAIM 14 the Now card's arrival past ${MOTION_MAX_MS} ms`).toEqual([]);
	} finally {
		await worker.stop();
	}
});
