// P19 — the QUEUE TAB itself, as opposed to the live-controls card at the top of it (p16) or the reorder
// arithmetic (the unit suite). Four claims, each of which needed a real browser because each is about what the
// route RENDERS rather than what a function returns:
//
//   1. An unjoined visitor gets the join landing. /queue was the one tab route with no join gate, so a shared or
//      bookmarked link, a second device or a guest who had tapped Leave was told "Nothing queued yet" about a
//      room with hundreds of songs in it — and pointed at a "Sing tab" whose dock belongs to a joined singer.
//   2. A cold load announces NOTHING. `queueAnnouncement` is silent with a null baseline for exactly this
//      reason, and the route defeated it by seeding the baseline from the pre-socket empty list; the first sync
//      then diffed the whole room against `[]`. The CONTROL is in the same test, because silence is easy to buy
//      by accident: another guest's add must still be announced.
//   3. A COOKING row can be picked up. The route passed `reorderable`, which ProcessingCard reads only as an
//      extra term in its actions gate — the handle's gate is `grip` — so a song that holds a turn for minutes was
//      the one row in the list with no handle and no keyboard path.
//   4. The clock cannot go backwards or past the end of the song. Both halves are the SAME drive, because they
//      are two readings of one sampled series.
//
// WHY NO FAKE WORKER IN THREE OF THE FOUR. `queueCardKind` needs a live `media:status`, not a missing one, so a
// cooking row is bought by processing a song with NOBODY to run the job: /api/process enqueues it, the server
// publishes `status: 'queued'`, and the card reads "Making karaoke… 0%" indefinitely. That is both cheaper than
// a worker and a better fixture — the row stays cooking for the whole test instead of racing it to ready. The
// clock test is the one that needs a real worker, because only a READY song is promoted to playing.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import type { Page } from '@playwright/test';

/** Two distinct local fixtures, matched by the substring their FILENAMES carry — search matches on title, so
 *  one query cannot surface both. Two is the minimum the grip needs: `gripVisible` asks only whether a second
 *  position exists. */
const QUERY_A = 'caroline';
const QUERY_B = 'believin';

/**
 * Queue a song that is NOT ready, through the sparkle. Deliberately not `SEL.addTurn`: that action is the
 * ready-song one, and /library hardcodes `readiness="ready"`, so neither can ever produce a cooking row — the
 * first reading of this finding was driven that way and measured zero `.proc` rows.
 */
async function singUnprocessed(phone: Page, query: string): Promise<void> {
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(query);
	await phone.locator(SEL.sing).first().click();
}

/** `.sr-live`'s text, trimmed. Empty string and absent are different answers and both are legitimate here. */
async function liveText(page: Page): Promise<string | null> {
	const region = page.locator(SEL.queueLive).first();
	if ((await region.count()) === 0) return null;
	return ((await region.textContent()) ?? '').trim();
}

test('an unjoined phone gets the join landing, never an empty queue', async ({ world, browser }) => {
	// A cooking row rather than nothing, so the room the unjoined visitor is lied TO about really has a queue —
	// the defect was the route reporting its own empty store as an empty room.
	const owner = await world.openPhone('P19Gate');
	await singUnprocessed(owner, QUERY_A);
	await openQueue(owner);
	await expect(owner.locator(SEL.processing).first()).toBeAttached();

	// Its own context, so its own (absent) cookie: `world.openPhone` joins, which is the state under test's
	// opposite. Closed in a finally because the fixture only tears down pages IT opened.
	const stranger = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: world.baseURL });
	const page = await stranger.newPage();
	try {
		await page.goto('/queue');
		await expect(page.locator(SEL.joinColumn).first()).toBeAttached();
		const body = (await page.locator(SEL.pageBody).innerText()).toLowerCase();
		expect(body, 'an unjoined visitor is still told the room is empty').not.toContain('nothing queued yet');
		expect(body, 'the copy still points at a tab bar this visitor has no dock for').not.toContain('sing tab');
		expect(await page.locator(SEL.dock).count(), 'an unjoined visitor got the joined phone chrome').toBe(0);
		// The `?room=` half of the same finding: the code used to be ignored, and the only way off the screen
		// dropped it, so a guest holding the code was asked to type it. JoinLanding reads it itself and lands on
		// the IDENTITY pane — the name field, which does not exist on the code pane.
		await page.goto(`/queue?room=${encodeURIComponent(world.code)}`);
		await expect(page.locator(SEL.nameInput).first()).toBeAttached();
	} finally {
		await stranger.close();
	}

	// The CONTROL that matters as much as the claim: the gate must not cost a JOINED guest the route. A full
	// document load, not a client-side tab switch, because `me` arrives from /api/me and the flash window is the
	// cold one.
	await owner.goto('/queue');
	await expect(owner.locator(SEL.dock).first()).toBeAttached();
	await expect(owner.locator(SEL.processing).first()).toBeAttached();
	expect(await owner.locator(SEL.joinColumn).count(), 'a joined guest was left on the join landing').toBe(0);
});

test('a cold load of /queue announces nothing, and another guest’s add still announces', async ({ world }) => {
	// THE ROW IN THE QUEUE MUST BELONG TO SOMEONE ELSE, and this is the whole fixture: `queueAnnouncement` is
	// silent about MY OWN adds by design ("I just tapped the button, and the row appearing is its own
	// confirmation"), so a room whose only turn is the reader's own is silent on a broken tree too — a version of
	// this test that queued from the measuring phone PASSED against the defect. The reported repro was a room
	// with hundreds of OTHER people's songs in it.
	const other = await world.openPhone('P19Other');
	await singUnprocessed(other, QUERY_A);
	const phone = await world.openPhone('P19Live');

	// A FULL DOCUMENT LOAD is the whole subject: the reporter's own control is that a client-side tab switch is
	// already silent, because the store is populated by then. Three reads spanning the socket's first sync, which
	// is when the defect fired — the region was server-rendered EMPTY and then mutated to "N songs added to the
	// queue" several hundred ms later, which is a live announcement and not skippable initial content.
	await phone.goto('/queue', { waitUntil: 'commit' });
	const loadedAt = Date.now();
	const reads: (string | null)[] = [];
	// Offsets from the load, not sleeps between reads: a read costs a round trip, so chained sleeps drift past
	// the window the defect lived in.
	for (const at of [400, 1200, 2400]) {
		const wait = loadedAt + at - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		reads.push(await liveText(phone));
	}
	// A null read is the region not attached yet, which is also silence.
	expect(
		reads.map((r) => r ?? ''),
		'the join snapshot was read aloud'
	).toEqual(['', '', '']);
	// FIXTURE INVARIANT, so the silence above cannot be the silence of an empty queue: there is a row to have
	// announced. Thrown rather than asserted — a vacuous pass is the failure mode this guards.
	await expect(phone.locator(SEL.processing).first()).toBeAttached();

	// THE CONTROL. The fix must buy silence about the BASELINE, not silence. Another guest's add is the one piece
	// of queue news this guest did not cause, which is the region's entire purpose — and the same guest whose
	// first song the baseline above had to swallow, so the two halves cannot both be bought by one behaviour.
	await singUnprocessed(other, QUERY_B);
	await expect
		.poll(() => liveText(phone), {
			timeout: 15_000,
			message: 'another guest queued a song and the polite region said nothing'
		})
		.toContain('P19Other queued');
});

test('a cooking row carries a grip, and an arrow key on it moves the row', async ({ world }) => {
	const phone = await world.openPhone('P19Grip');
	// TWO cooking rows, and both from this phone so both are removable and neither is promoted: a processing
	// entry is never `nextPlayable`, so an idle room leaves both in the queued list.
	await singUnprocessed(phone, QUERY_A);
	await singUnprocessed(phone, QUERY_B);
	await openQueue(phone);

	const procRows = phone.locator(SEL.processing);
	await expect(procRows).toHaveCount(2);
	const procGrips = phone.locator(`${SEL.processing} ${SEL.queueGrip}`);
	// THE CLAIM. Measured at 0 before the fix, with both neighbours draggable: the route passed `reorderable`
	// where the component gates its handle on `grip`.
	await expect(procGrips, 'a cooking row has no drag handle while every ready row beside it has one').toHaveCount(2);

	// THE KEYBOARD PATH, which is the single-pointer alternative (SC 2.5.7) and was equally absent: without
	// `onnudge` the handler fires into nothing. Driven on the grip rather than the card, because that is the only
	// element that binds Arrow Up/Down.
	// ORDER BY TITLE, not by the `.seq` numbers: `liveSeq` numbers rows by POSITION, so the printed digits read
	// 1,2 before and after — it is which row wears which that moves. `allInnerTexts` is in DOM order, which
	// `measureRowBoxes` also relies on.
	const titlesBefore = await phone.locator(SEL.queueTitle).allInnerTexts();
	expect(titlesBefore, 'the fixture did not produce two distinct rows to swap').toHaveLength(2);
	const first = procGrips.first();
	await first.focus();
	await first.press('ArrowDown');
	await expect
		.poll(() => phone.locator(SEL.queueTitle).allInnerTexts(), {
			timeout: 10_000,
			message: `the queue order never left ${JSON.stringify(titlesBefore)} after an arrow key on a cooking row`
		})
		.toEqual([titlesBefore[1], titlesBefore[0]]);
	// AND IT WAS ANNOUNCED. Either sentence is a pass, and that is a finding of its own rather than a hedge:
	// `nudge` writes "Moved to <ordinal> in the queue." synchronously and the announcement effect then re-runs on
	// the new list — same membership, different order — and overwrites it with "Queue reordered". So the ordinal
	// survives about a tick. PRE-EXISTING and not this group's: it is the same race on a ready row, it predates
	// the grip these two rows just gained, and nothing in the reviewed findings names it. Asserting only the
	// ordinal would pin a race; asserting silence-or-not is the claim that holds.
	await expect
		.poll(() => liveText(phone), {
			timeout: 10_000,
			message: 'an arrow key on a cooking row moved the row and announced nothing'
		})
		.toMatch(/Moved to|Queue reordered/);
});

/**
 * The clock, with a song on stage and NOBODY reporting its position — which is the state a room is in whenever
 * the display has not been attached yet, or has gone.
 *
 * ONE SERIES, TWO CLAIMS, because they are two readings of the same samples and a second drive would be a second
 * playback with its own timing:
 *   · MONOTONIC. The route mirrored `room.playback` as an object, and `proxy()` has no identity cache, so every
 *     room emit minted a fresh proxy and re-ran the anchor effect — which rewrote the position to the last
 *     broadcast one even when nothing had changed. The client heartbeat is 15s and the server answers every
 *     `hello` with `playback:state`, so an idle phone's clock sawtoothed backwards four times a minute.
 *   · CAPPED AT THE SONG'S LENGTH. `drawPosition` extrapolates with no duration term, so the elapsed figure ran
 *     past the end while `formatRemaining` pinned at −0:00 and the two halves of one readout disagreed.
 * The fixture tracks are EIGHT SECONDS, which is what makes both observable inside one short window: the cap
 * bites at 8s and the heartbeat reset bit at 15s.
 */
test('with no player reporting, the clock never goes backwards and never passes the end of the song', async ({
	world
}) => {
	// The one arm that needs a real worker: only a READY song is promoted to playing by `reconcileOnReady`, and
	// that promotion is what sets `isPlaying` with no display attached.
	const worker = await startFakeWorker(world);
	try {
		const phone = await world.openPhone('P19Clock');
		const track = await world.awaitDemoTrack(QUERY_A);
		const res = await phone.request.post('/api/process', { data: { mediaId: track.id } });
		if (!res.ok()) throw new Error(`/api/process refused "${track.title}": ${res.status()} ${await res.text()}`);
		await expect
			.poll(
				async () => {
					const body = (await phone.request.get('/api/library').then((r) => r.json())) as {
						library: { id: string; instrumentalRef?: string | null }[];
					};
					return body.library.some((m) => m.id === track.id && !!m.instrumentalRef);
				},
				{ timeout: 60_000, message: `"${track.title}" never reached ready with an instrumental ref` }
			)
			.toBe(true);

		await openBrowseFromHome(phone);
		await phone.locator(SEL.search).fill(QUERY_A);
		await phone.locator(SEL.addTurn).first().click();
		await expect(phone.locator(SEL.npStripTitle)).toContainText(track.title);
		await openQueue(phone);
		await expect(phone.locator(SEL.queueNowCard).first()).toBeAttached();

		// Past the 15s heartbeat by a clear margin, sampled every second because the readout is a whole number of
		// seconds and the defect was a 14-second step.
		const SAMPLES = 22;
		const series: number[] = [];
		for (let i = 0; i < SAMPLES; i += 1) {
			const text = ((await phone.locator(SEL.queueElapsed).first().textContent()) ?? '').trim();
			const m = /^(\d+):(\d\d)$/.exec(text);
			if (!m) throw new Error(`the elapsed readout is unreadable (${JSON.stringify(text)}), so no series exists`);
			series.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10));
			await new Promise((r) => setTimeout(r, 1000));
		}
		const detail = JSON.stringify(series);
		// FIXTURE INVARIANT: a frozen clock satisfies both claims below vacuously, so prove it ticked at all.
		if (series[series.length - 1]! <= series[0]!) {
			throw new Error(`the clock never advanced (${detail}); with nothing ticking neither claim has a subject`);
		}
		const backwards = series.findIndex((v, i) => i > 0 && v < series[i - 1]!);
		expect(backwards, `the clock stepped backwards at sample ${backwards}: ${detail}`).toBe(-1);
		// The CAP, read off the fixture rather than typed: seed.ts writes 8-second tones and core measures them
		// with ffmpeg, so the song's own duration is the only honest ceiling.
		const cap = Math.round(track.durationSec);
		expect(Math.max(...series), `the clock printed past the end of a ${cap}s song: ${detail}`).toBeLessThanOrEqual(cap);
	} finally {
		await worker.stop();
	}
});
