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
const heading = (p: Page, text: string | RegExp) => p.locator('h2.grouphead', { hasText: text });

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

		await worker.stop();
		await expect(sings(maya), 'gone once the grace has passed, with no new search').toHaveCount(0, {
			timeout: AFTER_GRACE_MS
		});
		await expect(heading(maya, CANT)).toBeVisible();
		const seeAll = maya.getByRole('link', { name: 'See all ready songs' });
		await expect(seeAll).toBeVisible();
		await shoot(maya, 'sing-search-maker-dropped');

		worker = await startFakeWorker(world, { capabilities: MAKER });
		await expect(sings(maya), 'a maker back: Sing buttons return within one broadcast').not.toHaveCount(0, {
			timeout: ONE_BROADCAST_MS
		});
		await expect(heading(maya, CANT)).toHaveCount(0);
		await worker.stop();
		await expect(seeAll).toBeVisible({ timeout: AFTER_GRACE_MS });
		await seeAll.click();
		await expect(maya).toHaveURL(/\/library/);
		for (const title of ready) await expect(maya.getByText(title).first()).toBeVisible();
	} finally {
		await worker.stop();
	}
});

test('an uploads-only worker: a library file keeps Sing, a YouTube result does not', async ({ world }) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { capabilities: MAKER });
	try {
		const maya = await world.openPhone('Maya');
		await maya.goto('/');
		await expect(promise(maya), 'a search result cannot be fetched, so the promise is not made').toHaveText(
			ONLY_READY,
			{ timeout: AFTER_GRACE_MS }
		);
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
