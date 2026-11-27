// #1176: A DOWNLOAD NEVER WAITS BEHIND A SEPARATION. Two guests pick two YouTube songs; the worker has one compute
// slot and its own fetch slot (`lanes`). Song 2's fetch must start while song 1 is still being separated and
// aligned, not after, and the room must read right the whole time: the TV lobby says "Making karaoke" while the
// phones do, and each guest's own queue card names their own song.
// `LANE_LESS=1` runs the same night on a worker that sends no lanes, the control: there song 2's fetch waits.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import type { Page } from '@playwright/test';

const ONE = 'Lane One';
const TWO = 'Lane Two';
const SAMPLE_MS = 250;

test.use({ youtubeSongs: [ONE, TWO] });

async function sing(phone: Page, title: string): Promise<void> {
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(title);
	const row = phone.locator(SEL.songRow).filter({ hasText: title });
	await row.locator(SEL.singAction).first().click();
	await phone.goto('/queue');
}

test("song 2's fetch starts before song 1's align ends, and the room reads right throughout", async ({ world }) => {
	test.setTimeout(180_000);
	const laneLess = process.env.LANE_LESS === '1';
	const worker = await startFakeWorker(world, {
		concurrency: 1,
		trueSlots: true,
		...(laneLess ? {} : { lanes: { fetch: 1, compute: 1 } }),
		// Two progress steps each: a 2 s download, a 3 s separation and a 6 s alignment.
		slowMsFor: { fetch: 1_000, stems: 1_500, align: 3_000 }
	});
	try {
		const tv = await world.openTv();
		const maya = await world.openPhone('Maya');
		const sam = await world.openPhone('Sam');
		await sing(maya, ONE);
		const fetch1 = await worker.awaitAssign({ jobType: 'fetch' });
		// Song 2 is picked once song 1 holds the compute slot: from here its fetch has only the fetch lane to go to.
		await worker.awaitAssign({ jobType: 'stems', mediaId: fetch1.mediaId });
		await sing(sam, TWO);

		const samples: string[] = [];
		const wrong: string[] = [];
		const t0 = Date.now();
		while (Date.now() - t0 < 90_000) {
			// `allInnerTexts` never waits: a card that leaves between a count and a read must not stall the sample.
			const firstText = async (p: Page, sel: string) =>
				((await p.locator(sel).allInnerTexts())[0] ?? '').replace(/\s+/g, ' ');
			const lobbyText = await firstText(tv, SEL.lobby);
			const making = [maya, sam].map(async (p) => (await p.locator(SEL.processing).count()) > 0);
			const [mayaMaking, samMaking] = await Promise.all(making);
			const cards = await Promise.all([maya, sam].map((p) => firstText(p, SEL.queueMyCard)));
			const line = `${Date.now() - t0}ms maya=${mayaMaking}[${cards[0]}] sam=${samMaking}[${cards[1]}] tv=${lobbyText}`;
			samples.push(line);
			if ((mayaMaking || samMaking) && lobbyText.includes('pick a song')) wrong.push(`TV says pick a song: ${line}`);
			if (cards[0] && !cards[0].includes(ONE)) wrong.push(`Maya's card is not her song: ${line}`);
			if (cards[1] && !cards[1].includes(TWO)) wrong.push(`Sam's card is not his song: ${line}`);
			const done = worker.assigns.filter((a) => a.jobType === 'align' && a.completedAt).length === 2;
			if (done && !mayaMaking && !samMaking) break;
			await maya.waitForTimeout(SAMPLE_MS);
		}
		const timeline = samples.join('\n');
		const jobs = worker.assigns.map(
			(a) => `${a.jobType}(${a.mediaId}) ${a.assignedAt! - t0}..${(a.completedAt ?? NaN) - t0}`
		);
		const story = `jobs:\n${jobs.join('\n')}\n\ntimeline:\n${timeline}`;
		console.log(`[p28] ${laneLess ? 'lane-less' : 'laned'} jobs (ms from song 2's pick):\n${jobs.join('\n')}`);

		const fetch2 = worker.assigns.find((a) => a.jobType === 'fetch' && a.mediaId !== fetch1.mediaId);
		const align1 = worker.assigns.find((a) => a.jobType === 'align' && a.mediaId === fetch1.mediaId);
		expect(fetch2, `song 2 was never fetched:\n${story}`).toBeDefined();
		expect(align1?.completedAt, `song 1 never finished aligning:\n${story}`).toBeDefined();
		expect(fetch2!.assignedAt!, `song 2's fetch waited for song 1's align to end:\n${story}`).toBeLessThan(
			align1!.completedAt!
		);
		expect(worker.assigns.filter((a) => a.completedAt).length, `not every job finished:\n${story}`).toBe(6);
		expect(wrong, story).toEqual([]);
	} finally {
		await worker.stop();
	}
});
