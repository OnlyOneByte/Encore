// PROPOSAL 24, PR 2: WITH NO KARAOKE MAKER, THE SING TAB SAYS SO BEFORE YOU PICK. The tab promised "we'll make the
// karaoke track for it" and offered a Sing button on every unmade row while nothing could make one, so the first pick
// of an offline night always died. Now the room's `canMake`/`canFetch` decide: an unmade row nothing can make sits
// under "Can't make these right now" with no Sing button, and "See all ready songs" answers "which ones are ready?".
// Three nights: no worker from the start, a worker dropping mid-night, and an uploads-only worker (no yt-dlp).
// Every night is off the network: `/?source=local` (the demo library is local files), and for the uploads-only night
// a routed `/api/search` that answers the local index plus one fixed YouTube hit.
// `SING_SHOTS=<dir>` writes phone 390 and 320 stills.
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { readySong } from '../../world/actors';

const ONLY_READY = 'Only ready songs can play right now.';
const PROMISE = "Find any song and we'll make the karaoke track for it.";
/** `cantMakeHeading`: singular over one row, plural over more. */
const CANT = /Can't make (these|this one) right now/;
/** The hub's 10 s grace, plus one broadcast and a loaded host. */
const AFTER_GRACE_MS = 20_000;
const ONE_BROADCAST_MS = 5_000;
const MAKER = ['stems', 'align'];
/** A YouTube search hit, fixed so the uploads-only night needs no live resolver. Never processed: it has no button. */
const YOUTUBE_HIT = {
	id: 'p24-youtube-bohemian',
	source: 'youtube',
	sourceRef: 'p24bohemian',
	title: 'Bohemian Rhapsody (YouTube)',
	artist: 'Queen',
	durationSec: 355,
	stemStatus: 'none'
} as const;

const shotsDir = process.env.SING_SHOTS;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
async function shoot(phone: Page, name: string): Promise<void> {
	if (!shotsDir) return;
	await phone.screenshot({ path: join(shotsDir, `phone-390-${name}.png`) });
	await phone.setViewportSize({ width: 320, height: 568 });
	await phone.screenshot({ path: join(shotsDir, `phone-320-${name}.png`) });
	await phone.setViewportSize({ width: 390, height: 844 });
}

const promise = (p: Page) => p.locator('.promise .shown');
const sings = (p: Page) => p.locator(SEL.songRow).locator(SEL.singAction);
// The words a heading SHOWS: the `Needs karaoke` heading carries the can't-make words as a hidden ghost to hold its
// height, and shows them itself once every row under it has lost its button (#1138).
const heading = (p: Page, text: string | RegExp) =>
	p.locator('h2.grouphead:not(:has(.swap)), h2.grouphead .swap > span:not(.ghost)', { hasText: text });

/** Tenet 3: sum every layout shift from now on that no input caused, and where each row sits. */
async function watchShifts(p: Page): Promise<void> {
	await p.evaluate(() => {
		const w = window as unknown as { __cls: number };
		w.__cls = 0;
		new PerformanceObserver((list) => {
			for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
				if (!e.hadRecentInput) w.__cls += e.value;
		}).observe({ type: 'layout-shift', buffered: false });
	});
}
const shifted = (p: Page) => p.evaluate(() => (window as unknown as { __cls: number }).__cls);
const rowTops = (p: Page) =>
	p.locator(SEL.songRow).evaluateAll((els) =>
		els.map((e) => {
			const r = e.getBoundingClientRect();
			return [Math.round(r.top), Math.round(r.height)];
		})
	);

/** Drop the maker under a search on screen, and hold the page to CLS 0: rows stay put, the link lands below them. */
async function dropHoldsStill(p: Page, stop: () => Promise<void>): Promise<void> {
	const before = await rowTops(p);
	await watchShifts(p);
	await stop();
	await expect(sings(p), 'gone once the grace has passed, with no new search').toHaveCount(0, {
		timeout: AFTER_GRACE_MS
	});
	const seeAll = p.getByRole('link', { name: 'See all ready songs' });
	await expect(seeAll).toBeVisible();
	await p.waitForTimeout(500); // past any trailing frame
	expect(await shifted(p), 'nothing moved under the guest when the maker dropped').toBe(0);
	expect(await rowTops(p), 'every row where it was').toEqual(before);
	const lastRow = await p.locator(SEL.songRow).last().boundingBox();
	const link = await seeAll.boundingBox();
	expect(link!.y, 'the link sits below the rows').toBeGreaterThanOrEqual(lastRow!.y + lastRow!.height);
}

async function search(p: Page, q: string, path = '/?source=local'): Promise<void> {
	await p.goto(path);
	await p.locator(SEL.search).fill(q);
	await expect(p.locator(SEL.songRow).first()).toBeVisible({ timeout: 15_000 });
}

test('no worker from the start: the tab says only ready songs play, and unmade rows have no Sing', async ({
	world
}) => {
	test.setTimeout(120_000);
	const maya = await world.openPhone('Maya');
	await maya.goto('/?source=local');
	await expect(promise(maya), 'the idle line, before anyone has picked').toHaveText(ONLY_READY, {
		timeout: AFTER_GRACE_MS
	});
	await shoot(maya, 'sing-idle-no-maker');
	await search(maya, 'bohemian');
	await expect(heading(maya, CANT)).toBeVisible();
	await expect(sings(maya), 'no Sing button a pick would die on').toHaveCount(0);
	await expect(maya.locator(SEL.songRow, { hasText: /bohemian/i }).first()).toBeVisible();
	await shoot(maya, 'sing-search-no-maker');
});

test('a worker dropping mid-night: Sing buttons go after the grace, "See all ready songs" opens them, and back', async ({
	world
}) => {
	test.setTimeout(240_000);
	let worker = await startFakeWorker(world, { capabilities: MAKER });
	const maya = await world.openPhone('Maya');
	try {
		const ready = [await readySong(world, maya, 'caroline'), await readySong(world, maya, 'believin')];
		await search(maya, 'bohemian');
		await expect(sings(maya), 'a maker is here, so the unmade row offers Sing').not.toHaveCount(0);
		await shoot(maya, 'sing-search-maker-online');

		// At 390: the drop moves nothing.
		await dropHoldsStill(maya, () => worker.stop());
		await expect(heading(maya, CANT)).toBeVisible();
		await shoot(maya, 'sing-search-maker-dropped');

		worker = await startFakeWorker(world, { capabilities: MAKER });
		await expect(sings(maya), 'a maker back: Sing buttons return within one broadcast').not.toHaveCount(0, {
			timeout: ONE_BROADCAST_MS
		});
		await expect(heading(maya, CANT)).toHaveCount(0);
		// At 320, where the headings wrap: the same drop moves nothing either.
		await maya.setViewportSize({ width: 320, height: 568 });
		await maya.waitForTimeout(500);
		await dropHoldsStill(maya, () => worker.stop());
		const seeAll = maya.getByRole('link', { name: 'See all ready songs' });
		await seeAll.click();
		await expect(maya).toHaveURL(/\/library/);
		for (const title of ready) await expect(maya.getByText(title).first()).toBeVisible();
	} finally {
		await worker.stop();
	}
});

test('an uploads-only worker: a library file keeps Sing, a YouTube result does not', async ({ world }) => {
	test.setTimeout(180_000);
	// A full worker first, then an uploads-only one in its place, so `canFetch` flips while this phone is CONNECTED:
	// the flip reaches it only by the sync the hub re-sends, never a reconnect's hello.
	const full = await startFakeWorker(world, { capabilities: [...MAKER, 'fetch:ytdlp'] });
	const maya = await world.openPhone('Maya');
	await maya.goto('/');
	await expect(promise(maya)).toHaveText(PROMISE, { timeout: AFTER_GRACE_MS });
	await maya.evaluate(async () => {
		const w = window as unknown as { __canFetch: unknown[] };
		w.__canFetch = [];
		const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=phone`);
		ws.onmessage = (ev: MessageEvent<string>) => {
			const m = JSON.parse(ev.data) as { type?: string; canFetch?: boolean };
			if (m.type === 'queue:sync' && m.canFetch !== undefined) w.__canFetch.push(m.canFetch);
		};
		await new Promise((r) => (ws.onopen = r));
	});
	const worker = await startFakeWorker(world, { capabilities: MAKER });
	await full.stop();
	try {
		await expect(promise(maya), 'a search result cannot be fetched, so the promise is not made').toHaveText(
			ONLY_READY,
			{ timeout: AFTER_GRACE_MS }
		);
		const told = await maya.evaluate(() => (window as unknown as { __canFetch: unknown[] }).__canFetch);
		expect(told, 'the open socket heard canFetch go false, with no reconnect').toContain(false);
		// The library's own file: made by this worker, so it keeps its Sing button.
		await search(maya, 'bohemian');
		await expect(sings(maya)).toHaveCount(1);
		await expect(heading(maya, CANT)).toHaveCount(0);
		// The default search, as a guest runs it, made HERMETIC the way motion.spec.ts's widen row is: the real answer
		// is the local index, plus one fixed YouTube hit, so no live resolver decides this test.
		await maya.route('**/api/search?*', async (r) => {
			const u = new URL(r.request().url());
			u.searchParams.set('source', 'local');
			const res = await r.fetch({ url: u.toString() });
			const body = (await res.json()) as { results?: unknown[] };
			await r.fulfill({ response: res, json: { ...body, results: [...(body.results ?? []), YOUTUBE_HIT] } });
		});
		await search(maya, 'bohemian', '/');
		const youtubeRow = maya.locator(SEL.songRow, { hasText: YOUTUBE_HIT.title });
		await expect(youtubeRow).toBeVisible();
		await expect(heading(maya, CANT)).toBeVisible();
		// A YouTube hit needs a fetcher this box does not have; the library file still offers Sing.
		await expect(youtubeRow.locator('button')).toHaveCount(0);
		await expect(sings(maya), 'only the library file offers Sing').toHaveCount(1);
		await shoot(maya, 'sing-search-uploads-only');
	} finally {
		await worker.stop();
	}
});

test('a split fleet: the fetcher leaving, then the maker, moves no row under the guest (#1138)', async ({ world }) => {
	test.setTimeout(240_000);
	const full = await startFakeWorker(world, { capabilities: [...MAKER, 'fetch:ytdlp'] });
	const uploads = await startFakeWorker(world, { capabilities: MAKER });
	const maya = await world.openPhone('Maya');
	try {
		// The library's unmade file and one YouTube hit, both under `Needs karaoke` with a Sing button.
		await maya.route('**/api/search?*', async (r) => {
			const u = new URL(r.request().url());
			u.searchParams.set('source', 'local');
			const res = await r.fetch({ url: u.toString() });
			const body = (await res.json()) as { results?: unknown[] };
			await r.fulfill({ response: res, json: { ...body, results: [...(body.results ?? []), YOUTUBE_HIT] } });
		});
		await maya.goto('/');
		await expect(promise(maya)).toHaveText(PROMISE, { timeout: AFTER_GRACE_MS });
		await search(maya, 'bohemian', '/');
		const youtubeRow = maya.locator(SEL.songRow, { hasText: YOUTUBE_HIT.title });
		await expect(sings(maya)).toHaveCount(2);
		await shoot(maya, 'sing-split-before');
		const before = await rowTops(maya);

		// Only the fetcher leaves: the YouTube row loses its button where it is, and the upload keeps Sing.
		await full.stop();
		await expect(youtubeRow.locator('button'), 'the YouTube hit can no longer be fetched').toHaveCount(0, {
			timeout: AFTER_GRACE_MS
		});
		await expect(sings(maya), 'the upload still offers Sing').toHaveCount(1);
		await shoot(maya, 'sing-split-fetcher-left');
		expect(await rowTops(maya), 'every row where it was, the fetcher gone').toEqual(before);

		// Then the maker: nothing can make either row, and still nothing moves.
		await uploads.stop();
		await expect(sings(maya), 'no Sing button a pick would die on').toHaveCount(0, { timeout: AFTER_GRACE_MS });
		await expect(heading(maya, CANT)).toBeVisible();
		await shoot(maya, 'sing-split-maker-left');
		expect(await rowTops(maya), 'every row where it was, the maker gone too').toEqual(before);
	} finally {
		await full.stop();
		await uploads.stop();
	}
});

test('an uploads-only room gains a fetcher: Sing comes back in place, then one heading when all leave (#1138)', async ({
	world
}) => {
	test.setTimeout(240_000);
	const uploads = await startFakeWorker(world, { capabilities: MAKER });
	let full: Awaited<ReturnType<typeof startFakeWorker>> | undefined;
	const maya = await world.openPhone('Maya');
	try {
		await maya.route('**/api/search?*', async (r) => {
			const u = new URL(r.request().url());
			u.searchParams.set('source', 'local');
			const res = await r.fetch({ url: u.toString() });
			const body = (await res.json()) as { results?: unknown[] };
			await r.fulfill({ response: res, json: { ...body, results: [...(body.results ?? []), YOUTUBE_HIT] } });
		});
		await maya.goto('/');
		await expect(promise(maya)).toHaveText(ONLY_READY, { timeout: AFTER_GRACE_MS });
		await search(maya, 'bohemian', '/');
		const youtubeRow = maya.locator(SEL.songRow, { hasText: YOUTUBE_HIT.title });
		await expect(youtubeRow).toBeVisible();
		await expect(heading(maya, CANT)).toHaveCount(1);
		await expect(sings(maya), 'only the upload offers Sing').toHaveCount(1);
		const before = await rowTops(maya);

		// A fetcher joins: the YouTube row's Sing comes back in its kept box, with no new search, and nothing moves.
		full = await startFakeWorker(world, { capabilities: [...MAKER, 'fetch:ytdlp'] });
		await expect(sings(maya), 'both rows offer Sing again').toHaveCount(2, { timeout: AFTER_GRACE_MS });
		await expect(heading(maya, CANT), 'no heading says a makeable song cannot be made').toHaveCount(0);
		await shoot(maya, 'sing-split-fetcher-joined');
		expect(await rowTops(maya), 'every row where it was, the fetcher here').toEqual(before);

		// Every worker leaves: one can't-make heading speaks for both rows, and still nothing moves.
		await full.stop();
		await uploads.stop();
		await expect(sings(maya)).toHaveCount(0, { timeout: AFTER_GRACE_MS });
		await expect(heading(maya, CANT), 'one heading, not two the same').toHaveCount(1);
		await expect(heading(maya, "Can't make these right now")).toHaveCount(1);
		// And in Chrome's own accessibility tree, what a screen reader reads: one can't-make heading, no empty one (#1392).
		const cdp = await maya.context().newCDPSession(maya);
		const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
			nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[];
		};
		const heads = nodes.filter((n) => !n.ignored && n.role?.value === 'heading').map((n) => n.name?.value ?? '');
		expect(
			heads.filter((h) => CANT.test(h)),
			heads.join(' | ')
		).toHaveLength(1);
		expect(heads, 'an empty heading').not.toContain('');
		await shoot(maya, 'sing-split-all-left');
		expect(await rowTops(maya), 'every row where it was, every worker gone').toEqual(before);
	} finally {
		await full?.stop();
		await uploads.stop();
	}
});

test('a full worker keeps every Sing button and the promise', async ({ world }) => {
	test.setTimeout(120_000);
	const worker = await startFakeWorker(world, { capabilities: [...MAKER, 'fetch:ytdlp'] });
	try {
		const maya = await world.openPhone('Maya');
		await maya.goto('/?source=local');
		await maya.waitForTimeout(12_000); // past the boot grace: nothing flips
		await expect(promise(maya)).toHaveText(PROMISE);
		await search(maya, 'bohemian');
		await expect(sings(maya)).toHaveCount(1);
		await expect(heading(maya, CANT)).toHaveCount(0);
		await shoot(maya, 'sing-search-maker-full');
	} finally {
		await worker.stop();
	}
});
