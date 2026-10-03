// P17 — /library, THE BROWSE PAGE.
//
// WHY THE PAGE EXISTS, because it decides what is worth asserting: the home column stacked the whole library
// UNDER an unbounded queue, so a busy rotation put the songs you already own metres down a scroll. The home
// field cannot stand in for them — it FETCHES from three resolvers and needs a name you already know, and
// browsing is for when you do not.
//
// THE ONE CLAIM THAT NEEDS A BROWSER. `browseLibrary` and its facets are pure and covered exhaustively by
// tests/unit/lib/library-browse.test.ts — filtering, folding, facet ranking, the stranding rule, every sort.
// None of that is re-asserted here. What a unit test CANNOT see is whether the route renders at all (a Svelte 5
// template error is invisible to svelte-check and to `bun run build`), whether the field is wired to the rows,
// and whether the chrome actually reaches the page. That is this spec's whole subject.
//
// ONE READY SONG, AND WHY THERE ARE NOT FIVE. A ready song means a REAL stem separation: /api/process then a
// poll, ~60s of worker. The shelf's cap — four rows at the 390x844 `openPhone` viewport every test below uses,
// eight at --bp-lg — and the `See all N` door need five to become observable, so
// they are NOT asserted here — five separations would put this spec past ten minutes for a `slice(0, 4)`. The
// cap is stated in the route beside the number it uses; what IS covered below is that the page the door leads
// to works, which is the half that can break silently.
//
// THE DEMO FIXTURE CARRIES NO ARTIST AND NO TAGS, so the facet chip rows do not render against it —
// `trackNameFromFile` only reads an artist off the `Artist - Title.ext` form and every fixture file is
// kebab-case (p12 documents the same gap for its own artist-facet sections). The chips are therefore asserted
// ABSENT here, which is the honest observable, and their logic lives in the unit suite where a fixture can
// actually carry an artist.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker, type FakeWorker } from '../../world/workers';
import type { World } from '../../world/fixtures';
import type { Page } from '@playwright/test';
import type { Media } from '$lib/contract';

interface SearchBody {
	ready: Media[];
	processing: Media[];
	results: Media[];
}

/**
 * Process one seeded local song all the way to ready, and hand back the row with the worker that made it.
 * The expensive precondition, and the reason there is one ready song here rather than five.
 *
 * `startFakeWorker` rather than the real Python worker: the subject is a PAGE, and what it needs from the job
 * path is a row with an `instrumentalRef` on disk — which this publishes through the real assign/accept/publish
 * path. A real separation would add minutes and a model download to assert nothing extra.
 */
async function oneReadySong(world: World, phone: Page): Promise<{ row: Media; worker: FakeWorker }> {
	const worker = await startFakeWorker(world);
	const track = await world.awaitDemoTrack();
	const search = async () =>
		(await phone.request.get(`/api/search?q=${encodeURIComponent(track.title)}`).then((r) => r.json())) as SearchBody;

	const found = await search();
	const row = [...found.ready, ...found.processing, ...found.results].find((x) => x.source === 'local');
	if (!row) throw new Error(`no local song matching "${track.title}" — the demo fixture did not index`);

	if (!found.ready.some((r) => r.id === row.id)) {
		const res = await phone.request.post('/api/process', { data: { mediaId: row.id } });
		if (!res.ok()) throw new Error(`/api/process refused "${track.title}": ${res.status()} ${await res.text()}`);
		await expect
			.poll(async () => (await search()).ready.some((r) => r.id === row.id && !!r.instrumentalRef), {
				timeout: 90_000,
				message: `"${row.title}" never reached ready with an instrumental ref — /library has no subject`
			})
			.toBe(true);
	}
	return { row, worker };
}

test('the library page renders its rows, and the filter narrows them in place', async ({ world }) => {
	const phone = await world.openPhone('Libby');
	const { row, worker } = await oneReadySong(world, phone);
	try {
		await phone.goto(`${world.baseURL}/library`);

		// The route RENDERS — the assertion a unit test cannot make. A template error leaves `main` empty.
		await expect(phone.locator(SEL.libraryFilter)).toBeVisible();
		await expect(phone.locator(SEL.songRow)).toHaveCount(1);
		await expect(phone.locator(SEL.songTitle).first()).toContainText(row.title);

		// The count line, which is what distinguishes this field from the home column's fetching one.
		await expect(phone.locator(SEL.libraryCount)).toHaveText(/1 song/);

		// A term from the title keeps the row; the count stays a statement about the WHOLE library.
		const term = row.title.split(/\s+/)[0]!;
		await phone.locator(SEL.libraryFilter).fill(term);
		await expect(phone.locator(SEL.songRow)).toHaveCount(1);
		await expect(phone.locator(SEL.libraryCount)).toHaveText(/1 of 1 songs/);

		// A term that matches nothing empties the list WITHOUT emptying the library, and offers the way out.
		await phone.locator(SEL.libraryFilter).fill('zzzznotasong');
		await expect(phone.locator(SEL.songRow)).toHaveCount(0);
		await expect(phone.locator(SEL.clearLibraryFilter)).toBeVisible();

		// Clearing restores the row in place — no request, no navigation.
		await phone.locator(SEL.clearLibraryFilter).click();
		await expect(phone.locator(SEL.songRow)).toHaveCount(1);

		// The demo fixture carries no artist and no tags, so neither chip row has anything to offer. See the header.
		await expect.soft(phone.getByRole('heading', { name: 'Artists' })).toHaveCount(0);
		await expect.soft(phone.getByRole('heading', { name: 'Tags' })).toHaveCount(0);
	} finally {
		await worker.stop();
	}
});

test('the chrome reaches the page, and a song added there lands in the rotation', async ({ world }) => {
	const phone = await world.openPhone('Libby');
	const { row, worker } = await oneReadySong(world, phone);
	try {
		// From the queue screen, through the door BESIDE THE FIELD — the affordance that fixes the reachability
		// complaint, and it sits on the field's leading edge because the trailing edge carries the spinner and clear.
		await phone.goto(world.baseURL);
		await expect(phone.locator(SEL.libraryLink)).toBeVisible();
		await phone.locator(SEL.libraryLink).click();
		await expect(phone).toHaveURL(/\/library$/);

		// Adding queues the song and does NOT navigate: picking two in a row is the normal case.
		await phone.locator(SEL.addTurn).first().click();
		await expect(phone).toHaveURL(/\/library$/);

		// And it really is in the rotation, not merely optimistic on this surface — asserted after a full page load,
		// so the claim is about the SERVER's queue and not this tab's optimistic store.
		//
		// QUEUED **OR** NOW PLAYING, and the union is the honest observable rather than a hedge: the room was idle, so
		// the only entry is eligible immediately and the rotation hands it straight to the stage. Asserting `.qrow`
		// alone failed for exactly that reason — `Nothing Queued` with the song already in the band.
		await phone.goto(world.baseURL);
		await expect
			.poll(
				async () =>
					(await phone.locator(SEL.queueTitle).allTextContents())
						.concat(await phone.locator(SEL.bandTitle).allTextContents())
						.some((t) => t.includes(row.title)),
				{ message: `"${row.title}" reached neither the queue nor the now-playing band` }
			)
			.toBe(true);

		// PageHeader's back control is a real anchor, so the way out of the leaf route is the browser's own too.
		await phone.goto(`${world.baseURL}/library`);
		await expect(phone.locator(SEL.backToQueue)).toBeVisible();
	} finally {
		await worker.stop();
	}
});
