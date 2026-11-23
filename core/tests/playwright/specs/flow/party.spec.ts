// The full room: two phones and a TV — join through search, queue, rotation and skip, driven by accessible
// role + name wherever a literal label exists. A flow that clicks by class keeps working after a control loses
// its accessible name, which is exactly the regression this flow exists to surface.
//
// ORDER MATTERS. The attract layout exists only while the room is EMPTY, so the ten-foot type is measured before
// anybody joins: asserting it after two guests join reads the LOBBY, finds nothing and reports 0px. The `world`
// fixture mints a room per test, so emptiness is a per-test given and only the order INSIDE a test has to be
// defended.
//
// THE ROUTABLE ADVERTISED ORIGIN is a precondition, not a claim. Core boots on 127.0.0.1 here, which the TV
// correctly calls unreachable and answers with the "Phones can’t open this address" notice; the old flow bailed rather than
// measure an attract screen it believed had no join address left on it. So the first test DECLARES a routable
// address through the product's own settings surface before opening the TV — `joinOrigin` outranks
// ENCORE_PUBLIC_ORIGIN, and the world fixture exposes no per-test core env. Measured while porting: with the
// notice on screen the three readings are UNCHANGED (44.0024px / 84.01px / 96px), because the notice now sits
// beside a QR that still renders rather than replacing the typed join block. The precondition is kept because it
// costs two HTTP calls and restores the screen the old flow measured — not because these numbers depend on it.
//
// SINGER NAMES ARE UNIQUE PER ROOM: the singers table is append-only, so a reused name is refused with 409 and
// the join page simply stays put, which looks exactly like a broken flow.
import { test, expect } from '../../world/fixtures';
import type { Page } from '@playwright/test';
import { SEL } from '../../world/selectors';
import { openBrowseFromHome, openQueue, isJoined } from '../../world/actors';
import { DEMO_LIBRARY } from '../../world/seed';
import { startFakeWorker } from '../../world/workers';
import { TEST_HOST_KEY } from '../../world/core';

// A real multi-character term: the remote does not search on a single character, so 'a' returns nothing and looks
// exactly like a broken UI.
const SEARCH_TERM = 'caroline';

// The demo track this flow queues, DERIVED from the fixture rather than re-typed — core takes a library track's
// title from its filename, so the filename is the title.
const DEMO_FILE = DEMO_LIBRARY.map((t) => t.file).find((f) => f.includes(SEARCH_TERM));
if (!DEMO_FILE) {
	// Thrown at collection, not skipped: a fixture that no longer contains the song this flow searches for is an
	// environment that cannot answer the question, and a silently-skipped flow is indistinguishable from rot.
	throw new Error(`no track in world/seed.ts DEMO_LIBRARY matches "${SEARCH_TERM}" — this flow searches for it`);
}
const DEMO_TITLE = DEMO_FILE.replace(/\.[^.]+$/, '');

// How long to let the TV's `hello`→`queue:sync` round trip land after the socket opens, before trusting what the
// screen says about the room. `connected` flips on `onopen` and the roster arrives one round trip later, so the
// socket being up is necessary and not sufficient, and the first render is NOT an answer to "is the room empty".
// A WIRE ROUND TRIP rather than a wait for a render — deliberately generous against a single-digit-ms loopback
// RTT, because the alternative is a flake that reads as a product defect. The re-check taken WITH the
// measurements is what keeps this number from being load-bearing.
const SYNC_SETTLE_MS = 800;

// How long the TV gets to answer a skip, over a loopback socket. DELIBERATELY TIGHT: "the stage is empty" is one
// of the two correct answers, and a song that ENDS empties the stage too — so a generous window lets an 8-second
// fixture satisfy this claim with the skip doing nothing at all. The press before it stops the playhead, and this
// bound is the second lock on the same door.
const SKIP_REACTION_MS = 5_000;

/** A search row as the API returns it — only the fields this flow reads. */
interface SearchRow {
	id: string;
	source: string;
	sourceRef: string;
	title: string;
}

/**
 * Wait until the demo track is INDEXED, and answer with it.
 *
 * The library scan is a boot pass that finishes AFTER /health answers, and the phone's search is debounced and
 * fires once per keystroke — nothing re-runs it when the index shows up later. So a phone that types too early
 * gets an answer from an empty library and the flow reads a product defect. THROWS with the remedy rather than
 * skipping: an unindexed library is an environment that cannot answer the question.
 */
async function awaitDemoTrack(baseURL: string, timeout = 30_000): Promise<SearchRow> {
	const deadline = Date.now() + timeout;
	let seen = 'nothing at all';
	while (Date.now() < deadline) {
		const res = await fetch(`${baseURL}/api/search?q=${encodeURIComponent(SEARCH_TERM)}`).catch(() => null);
		if (res?.ok) {
			const body = (await res.json()) as { ready?: SearchRow[]; processing?: SearchRow[]; results?: SearchRow[] };
			const rows = [...(body.ready ?? []), ...(body.processing ?? []), ...(body.results ?? [])];
			const hit = rows.find((r) => r.source === 'local' && r.sourceRef.includes(DEMO_TITLE));
			if (hit) return hit;
			seen = rows.map((r) => `${r.source}:${r.title}`).join(', ') || 'no rows';
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(
		`the demo library never indexed ${DEMO_FILE} within ${timeout / 1000}s, so "${SEARCH_TERM}" cannot find it. ` +
			`/api/search answered: ${seen}. The demo tracks only index when a file exists behind them and ffmpeg can ` +
			`read a duration — see world/seed.ts.`
	);
}

/**
 * Declare a ROUTABLE join address for this room, through the product's own settings surface.
 *
 * `PUT /api/settings` needs the host key, and the host need not join, so the room stays empty for the attract screen.
 */
async function declareRoutableJoinOrigin(baseURL: string, origin: string): Promise<void> {
	const host = await fetch(`${baseURL}/api/host`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ key: TEST_HOST_KEY })
	});
	expect(host.ok, `could not unlock the host key: ${host.status} ${await host.text()}`).toBe(true);
	const cookie = (host.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

	const put = await fetch(`${baseURL}/api/settings`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({ joinOrigin: origin })
	});
	expect(put.ok, `could not set joinOrigin=${origin}: ${put.status} ${await put.text()}`).toBe(true);
}

/** Every trimmed text a selector resolves to, as the old driver's `texts()` read them. */
async function texts(page: Page, selector: string): Promise<string[]> {
	return (await page.locator(selector).allTextContents()).map((t) => t.trim());
}

/** '' when absent, so "the badge is gone" is an assertion and not an exception. */
async function text(page: Page, selector: string): Promise<string> {
	const first = page.locator(selector).first();
	return (await first.count()) === 0 ? '' : ((await first.textContent()) ?? '').trim();
}

/**
 * The rotation as ONE phone renders it: the playing song first, then the waiting rows. Both, because a PLAYING
 * entry renders no `.qrow` at all, so a rotation read from rows alone is empty for a healthy room.
 */
async function rotationOf(page: Page): Promise<string[]> {
	// ON /queue, AND THAT IS THE WHOLE READING. `.qrow` used to be a section on `/`; the Sing tab renders none, so
	// the queued half of this was silently empty wherever it was called from until the route change went in. The
	// strip's title is chrome and resolves on either surface.
	// No `!== 'Nothing playing'` filter any more: that was the old band's idle copy, and the strip renders its
	// title element only when something IS playing, so an idle room yields [] rather than a placeholder string.
	await openQueue(page);
	const playing = (await texts(page, SEL.npStripTitle)).filter((t) => t);
	return [...playing, ...(await texts(page, SEL.queueTitle))];
}

test('the attract screen is legible at ten feet', async ({ world }) => {
	await declareRoutableJoinOrigin(world.baseURL, 'http://10.42.0.7:7777');

	const tv = await world.openTv();
	// The socket first: the room state cannot be believed before it opens.
	await tv.locator(SEL.tvConnected).waitFor({ timeout: 20_000 });
	// A DWELL ON PURPOSE (see SYNC_SETTLE_MS): there is no locator for "the roster has arrived and is empty", and
	// an auto-waiting query cannot prove an absence.
	await tv.waitForTimeout(SYNC_SETTLE_MS);
	await tv.locator(SEL.attract).waitFor({ timeout: 20_000 });
	expect(
		await tv.locator(SEL.badQr).count(),
		'the TV is advertising a join address phones cannot reach, so it is showing the "Phones can’t open this address" notice ' +
			'— correct behaviour, but it means this test never applied the routable origin it declared'
	).toBe(0);

	// MEASURE ALL THREE, re-check the screen ONCE, then assert — and in one round trip, so nothing can move
	// between the readings. Each value fails DIFFERENTLY on the lobby, which is the trap: an unmounted element
	// reads 0px, while `.brand` still exists but in flow, so `left` computes to `auto` → NaN, and `NaN >= 48`
	// reads exactly like a real layout regression.
	const m = await tv.evaluate(
		({ joinAddress, stageHeadline, stageBrand, attract }) => {
			const px = (selector: string, prop: 'font-size' | 'left'): number => {
				const el = document.querySelector(selector);
				return el ? parseFloat(getComputedStyle(el).getPropertyValue(prop)) : 0;
			};
			return {
				urlSize: px(joinAddress, 'font-size'),
				headlineSize: px(stageHeadline, 'font-size'),
				brandLeft: px(stageBrand, 'left'),
				attract: document.querySelectorAll(attract).length
			};
		},
		{
			joinAddress: SEL.joinAddress,
			stageHeadline: SEL.stageHeadline,
			stageBrand: SEL.stageBrand,
			attract: SEL.attract
		}
	);

	expect(
		m.attract,
		'the TV left the attract screen while this flow was measuring it, which means the room was not empty after ' +
			'all — something joined mid-measurement'
	).toBe(1);
	expect(
		m.urlSize,
		`the join URL is not legible at ten feet: computed ${m.urlSize}px — the ten-foot floor is 26px, and this ` +
			`was 22.4px before`
	).toBeGreaterThanOrEqual(26);
	expect(
		m.headlineSize,
		`the stage headline does not clear the ten-foot floor: computed ${m.headlineSize}px`
	).toBeGreaterThanOrEqual(26);
	expect(
		m.brandLeft,
		`stage chrome sits outside the overscan-safe margin: computed left ${m.brandLeft}px — a bare 48px would sit ` +
			`inside the overscan region on many sets`
	).toBeGreaterThanOrEqual(48);
});

test('two guests join in isolated sessions', async ({ world }) => {
	// Each on one end of the colour ring: `Home`/`End` land them far apart deterministically.
	const maya = await world.openPhone('Maya', { stop: 'Home' }); // the ring's first stop
	// Ada takes the other end of the ring — a colour the default never lands on.
	const ada = await world.openPhone('Ada', { stop: 'End' });

	expect(await isJoined(maya), 'Maya never reached the joined home').toBe(true);
	expect(await isJoined(ada), 'Ada never reached the joined home').toBe(true);

	// TWO CONTEXTS ARE TWO GUESTS WITH TWO COOKIE JARS; one context in two tabs is one guest. Asked of /api/me
	// through each page's own request context, so each answer is decided by that context's session cookie.
	const nameOf = async (page: Page): Promise<string> => {
		const me = (await (await page.request.get('/api/me')).json()) as { singer?: { displayName?: string } };
		return me.singer?.displayName ?? '';
	};
	expect([await nameOf(maya), await nameOf(ada)], 'the two phones are not two separate singers').toEqual([
		'Maya',
		'Ada'
	]);
});

test('a wheel hue survives the round trip instead of collapsing to a preset', async ({ world }) => {
	// `End` is the far end of the ring — a colour the default never lands on, and not one of the eight presets.
	const ada = await world.openPhone('Ada', { stop: 'End' });
	const me = (await (await ada.request.get('/api/me')).json()) as { singer?: { color?: string } };
	const colour = me.singer?.color ?? '';

	expect(
		colour,
		`the server returned ${colour || '(nothing)'} for a hue picked off the wheel — #7c5cff would mean the old ` +
			`allowlist is back`
	).toMatch(/^#[0-9a-f]{6}$/);
	expect(colour, 'the wheel hue collapsed to the default preset').not.toBe('#7c5cff');
});

test('a queued song reaches both phones in one rotation, and skip advances it', async ({ world }) => {
	// A WORKER, because a fresh room has no ready song: the action a search result offers is `sing` — queue AND
	// process — and the rotation's next move is only observable once the song can actually play. The rotation must
	// HOLD the slot while the song processes, which is why the shapes below all count.
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya', { stop: 'Home' });
		const ada = await world.openPhone('Ada', { stop: 'End' });
		const tv = await world.openTv();
		const demo = await awaitDemoTrack(world.baseURL);

		await openBrowseFromHome(maya); // search lives at the top of the joined home
		await maya.locator(SEL.search).fill(SEARCH_TERM);
		// Poll for rows instead of sleeping: search is debounced and then hits every resolver, so its latency is
		// not a number this file can know.
		await expect(
			maya.locator(SEL.songRow).first(),
			`the unified search box returned no rows for "${SEARCH_TERM}"`
		).toBeVisible({ timeout: 15_000 });
		const rows = await maya.locator(SEL.songRow).count();
		expect(rows, `the unified search box returned ${rows} rows`).toBeGreaterThan(0);

		// A fresh install has NO ready songs, so results carry `sing` rather than `add`. Count whichever is
		// offered: insisting on `add` would make this pass only on a machine already used.
		const readyCount = await maya.locator(SEL.addTurn).count();
		const rawCount = await maya.locator(SEL.sing).count();
		expect(
			readyCount + rawCount,
			`a search result offers no queueing action: ${readyCount} ready (${SEL.addTurn}), ` +
				`${rawCount} raw (${SEL.sing})`
		).toBeGreaterThan(0);

		// THE DEMO ROW BY NAME, not whichever action is first on screen: the same term returns a dozen YouTube rows
		// on a box with a network, and queueing one of those needs a `fetch:ytdlp` worker this flow does not run.
		// Then by ROLE + ACCESSIBLE NAME, covering both arms — `Sing <song> …` when the song still needs processing,
		// `Add a turn for <song>` when it is already ready.
		const demoRow = maya.locator(SEL.songRow).filter({ hasText: demo.title });
		await demoRow
			.getByRole('button', { name: /^(Sing |Add a turn)/ })
			.first()
			.click();

		// ONTO THE QUEUE TAB, which is a route now rather than a section of home: rotation rows and the processing
		// group live on /queue, and the transport is in the dock on every surface. Ada is still on `/` — the search
		// box is a field ON the Sing tab, so nothing pushed her anywhere — and `rotationOf` takes her to /queue
		// itself when it is asked.
		await openQueue(maya);

		// THREE shapes count, because the invariant is "the singer is in the rotation": an idle room auto-starts the
		// add and `queued` filters a playing entry out, so the FIRST song of the night is not a row at all — it is
		// in the strip. A processing song HOLDS its slot. Asserting only `.qrow` reports an empty rotation for a
		// healthy room.
		await expect
			.poll(
				async () => {
					const queued = await maya.locator(SEL.queueRow).count();
					const processing = await maya.locator(SEL.processing).count();
					// The strip's title renders only with a current entry, so its COUNT is the "something is playing"
					// term; the old `!== 'Nothing playing'` filter guarded against a placeholder that no longer exists.
					const playing = await maya.locator(SEL.npStripTitle).count();
					return queued + processing + playing;
				},
				{
					timeout: 30_000,
					message:
						`queueing never put the singer in the rotation: no ${SEL.queueRow}, no ${SEL.processing} and ` +
						`nothing in the strip. A processing song holds its slot and a playing one is named by the strip, which ` +
						`is why all three count.\n\n${worker.log()}`
				}
			)
			.toBeGreaterThan(0);

		// Wait for the OTHER phone rather than assuming a latency, and assert the wait SEPARATELY: an empty rotation
		// must fail as a missing precondition rather than slip past the agreement check below, where '[]' === '[]'
		// reads as agreement.
		await expect
			.poll(async () => (await rotationOf(ada)).length, {
				timeout: 30_000,
				message: 'the rotation never reached the second phone: Ada saw no non-empty rotation'
			})
			.toBeGreaterThan(0);

		const mayaQ = await rotationOf(maya);
		const adaQ = await rotationOf(ada);
		expect(mayaQ.length, `the rotation left the first phone: maya=${JSON.stringify(mayaQ)}`).toBeGreaterThan(0);
		expect(
			adaQ,
			`the two phones disagree about the rotation: maya=${JSON.stringify(mayaQ)} ada=${JSON.stringify(adaQ)}`
		).toEqual(mayaQ);

		// THE TV REACTS, driven from the phone. BY ACCESSIBLE NAME, and specifically by `Pause`: the disc's label IS
		// its state, so waiting for it waits for the room to have STARTED — an idle room auto-starts a song the
		// moment it can play — where waiting for the control to merely be ENABLED would press `Play` at a song that
		// is still processing and assert nothing. Pressing it also FREEZES the playhead, which is what keeps the
		// skip claim below honest: the fixture is 8 seconds long, so a running playhead can empty the stage by
		// ENDING, with no skip involved. Proved: with `skip` gutted in the player, a generous window passed this
		// test in 19s on the song's own ending.
		await maya.getByRole('button', { name: /^Pause$/ }).click();
		await expect(
			tv.locator(SEL.lowerThird),
			`the TV never named who is singing once playback started\n\n${worker.log()}`
		).toHaveCount(1, { timeout: 30_000 });
		const shownFirst = await text(tv, SEL.nowSong);

		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).click();
		// One song queued means a skip empties the rotation, so a different song OR an empty stage is correct; the
		// SAME song still showing means skip did nothing. BOUNDED TIGHTLY on purpose — see SKIP_REACTION_MS.
		await expect
			.poll(
				async () => (await tv.locator(SEL.lowerThird).count()) === 0 || (await text(tv, SEL.nowSong)) !== shownFirst,
				{
					timeout: SKIP_REACTION_MS,
					message: `skip did not advance the rotation: the TV still shows "${shownFirst}" on a lower-third`
				}
			)
			.toBe(true);
	} finally {
		await worker.stop();
	}
});

test('with nothing playable, the TV explains itself instead of going blank', async ({ world }) => {
	// NO WORKER ON PURPOSE. Nothing claims the stems job, so the queued song can never play — the arm the old flow
	// reached by accident whenever no worker happened to be running, declared here instead of guessed at.
	const maya = await world.openPhone('Maya', { stop: 'Home' });
	const tv = await world.openTv();
	const demo = await awaitDemoTrack(world.baseURL);

	await openBrowseFromHome(maya);
	await maya.locator(SEL.search).fill(SEARCH_TERM);
	await expect(maya.locator(SEL.songRow).first()).toBeVisible({ timeout: 15_000 });
	await maya
		.locator(SEL.songRow)
		.filter({ hasText: demo.title })
		.getByRole('button', { name: /^(Sing |Add a turn)/ })
		.first()
		.click();
	// ONTO /queue, not back to home: with no worker the pick stays queued, and a queued row is on the Queue tab.
	// Home is the Sing tab and renders no `.qrow` at all, so this assertion read 0 forever from there.
	await openQueue(maya);
	// The pick has to have LANDED before the TV is read, or this measures a room nobody has picked in yet.
	await expect(maya.locator(SEL.queueRow), 'the pick never reached the rotation').not.toHaveCount(0, {
		timeout: 30_000
	});

	// Assert the OBSERVABLE requirement: the TV must not sit on a blank stage or a stale lower-third.
	//
	// Deliberately NOT `.state-waiting`: reaching that state needs the PLAYER to be actively holding, so a
	// queued-but-never-started process falls through to the lobby copy. Pinning a test to that would freeze a
	// wording bug in place.
	expect(await tv.locator(SEL.lowerThird).count(), 'a stale lower-third would name a singer who is not singing').toBe(
		0
	);
	const body = ((await tv.locator(SEL.pageBody).textContent()) ?? '').trim();
	expect(body.length, `the TV went blank with nothing playable: body text was ${JSON.stringify(body)}`).toBeGreaterThan(
		20
	);
});
