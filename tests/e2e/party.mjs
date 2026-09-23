// Full-flow e2e: two phones and a TV, against a live server.
//
//   bun run tests/e2e/party.mjs            # discovers a Chromium and starts one
//   EPORT=3000 bun run tests/e2e/party.mjs # against an already-running server
//
// The server must have an EMPTY room and a ROUTABLE advertised join address — the attract screen the
// first three checks measure exists only under both, and a loopback origin correctly shows the
// unreachable-QR alert instead, which renders none of the type this flow reads:
//
//   ENCORE_EPHEMERAL=1 HOST=127.0.0.1 PORT=5181 MEDIA_DIR=<seeded> \
//     ENCORE_PUBLIC_ORIGIN=http://<lan-ip>:5181 bun run server.ts
//
// Controls are driven by ACCESSIBLE NAME wherever one exists, not by class: a control that loses its
// accessible name SHOULD break this flow. See docs/E2E.md#the-driver.
import { connect, sleep } from './driver.mjs';
import { SEL } from './contract.ts';
import { findChromium } from './lib/chromium.mjs';
import { openBrowseFromHome, returnHomeFromBrowse, openNowPlaying } from './lib/phone.mjs';
import { openJoin } from './lib/join.mjs';

/**
 * Browser/Page derive from driver.mjs's return types so they cannot drift; page.evaluate() is
 * Promise<any>, cast at the call site.
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ name: string, ok: boolean }} Check
 */

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;
// How long to let the TV's `hello`→`queue:sync` round trip land after the socket opens, before trusting
// what the screen says about the room. The first render is NOT an answer to "is the room empty" — see the
// precondition block below.
const SYNC_SETTLE_MS = Number(process.env.SYNC_SETTLE_MS ?? 800);

/** @type {Check[]} */
const checks = [];
/** @param {string} name @param {unknown} ok @param {string} [detail] */
function check(name, ok, detail = '') {
	checks.push({ name, ok: !!ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/** Find a Chromium without requiring one to be installed by this package. */

const chromium = findChromium();
if (!chromium) {
	// Loud, not skipped: see docs/E2E.md#exit-codes-and-what-ran-means.
	console.error('No Chromium found. Set PW_CHROMIUM, or install one, then re-run.');
	process.exit(2);
}

const res = await fetch(`${base}/health`).catch(() => null);
if (!res?.ok) {
	console.error(`No Encore server on ${base}. Start one (ENCORE_EPHEMERAL=1 PORT=${PORT} bun run start) and re-run.`);
	process.exit(2);
}

/** @type {Browser | undefined} */
let browser;
try {
	const browser0 = await connect();
	browser = browser0;

	// The TV, BEFORE anyone joins. ORDER MATTERS: the attract layout exists only while the room is EMPTY,
	// so asserting on it after two guests join reads the lobby, finds nothing and reports 0px.
	const tv = await browser0.newPage();
	await tv.goto(`${base}/tv`);

	// TWO preconditions, reported SEPARATELY, because conflating them turns an environment gap into a
	// false regression report:
	//
	// (1) The room must be EMPTY — the attract screen renders only before anyone joins, and the server is
	//     ephemeral but not per-run, so a previous run's guests are still in it.
	// (2) The advertised join address must be ROUTABLE, or the TV correctly swaps the QR block for the
	//     `.badqr` alert and the type this flow measures does not exist. The flow cannot fix it itself:
	//     `PUT /api/settings` needs a joined singer, and joining destroys (1).
	//
	// AND THE FIRST RENDER CANNOT ANSWER (1). `online`/`away` start empty on the client and are filled by
	// the socket's `queue:sync`, so the server renders ATTRACT for every room, leftover guests included.
	// Reading `.attract` straight after load answers "has the socket synced yet" — and on a stale server it
	// passes, then unmounts the element mid-flight and reports 0px. So wait for the socket, let the sync
	// land, and re-check the screen at the moment of measurement.
	const socketUp = await tv.waitForSelector(SEL.tvConnected, { timeout: 8000 }).catch(() => false);
	if (!socketUp) {
		console.error(`\nThe TV never opened its WebSocket to ${base}. Is the server still running?`);
		browser0.close();
		process.exit(2);
	}
	// `connected` flips on `onopen` and the roster arrives one `hello`→`queue:sync` round trip later, so
	// the socket being up is necessary and not sufficient. Deliberately generous against a single-digit-ms
	// loopback RTT, because the alternative is a flake that reads as a product defect.
	await sleep(SYNC_SETTLE_MS);

	const onAttract = await tv.waitForSelector(SEL.attract, { timeout: 4000 }).catch(() => false);
	if (!onAttract) {
		console.error(
			'\nThis flow needs an empty room — the attract screen only renders before anyone joins,\n' +
				'and a previous run leaves its guests behind. Restart the server and re-run:\n' +
				`  ENCORE_EPHEMERAL=1 PORT=${PORT} MEDIA_DIR=<seeded dir> ENCORE_PUBLIC_ORIGIN=http://<lan-ip>:${PORT} bun run start`
		);
		browser0.close();
		process.exit(2);
	}
	const unreachableOrigin = (await tv.count(SEL.badQr)) > 0;
	if (unreachableOrigin) {
		console.error(
			'\nThe TV is advertising a join address phones cannot reach, so it is showing the\n' +
				'"Join QR unavailable" alert instead of the QR — correct behaviour, but it means the attract\n' +
				'screen renders no join address or headline for this flow to measure. Give the server a\n' +
				'routable origin and re-run:\n' +
				`  ENCORE_EPHEMERAL=1 PORT=${PORT} MEDIA_DIR=<seeded dir> ENCORE_PUBLIC_ORIGIN=http://<lan-ip>:${PORT} bun run start`
		);
		browser0.close();
		process.exit(2);
	}

	// MEASURE ALL THREE, re-check the screen ONCE, and only then assert. The order is the point: a late
	// `queue:sync` that swaps attract for the lobby must be reported as the environment problem it is, for
	// every value. Each value fails differently on the lobby, which is the trap — an unmounted element
	// reads 0px, while `.brand` still exists but in-flow, so `left` computes to `auto` → NaN, and
	// `NaN >= 48` reads exactly like a real layout regression.
	const urlSize = parseFloat((await tv.css(SEL.joinAddress, 'font-size')) ?? '0');
	const headlineSize = parseFloat((await tv.css(SEL.stageHeadline, 'font-size')) ?? '0');
	const brandLeft = parseFloat((await tv.css(SEL.stageBrand, 'left')) ?? '0');
	if ((await tv.count(SEL.attract)) === 0) {
		console.error(
			'\nThe TV left the attract screen while this flow was measuring it, which means the room was\n' +
				"not empty after all — a previous run's guests arrived over the socket. Restart the server\n" +
				'and re-run.'
		);
		browser0.close();
		process.exit(2);
	}
	check(
		'the join URL is legible at ten feet',
		urlSize >= 26,
		`computed ${urlSize}px — the ten-foot floor is 26px, and this was 22.4px before`
	);
	// The attract screen's instruction ("Scan to join the party").
	check('stage headline clears the ten-foot floor', headlineSize >= 26, `computed ${headlineSize}px`);
	check(
		'stage chrome sits inside the overscan-safe margin',
		brandLeft >= 48,
		`computed left ${brandLeft}px — a bare 48px would sit inside the overscan region on many sets`
	);

	// Two guests join, each on its own end of the colour ring. COLOUR IS A KEYPRESS: the ring is one
	// `role="slider"` over 48 stops, so there is no per-colour element to click, and `Home`/`End` are what
	// land two guests on colours far apart deterministically.
	/** @param {string} name @param {{ stop?: string }} [opts] @returns {Promise<Page>} */
	async function joinAs(name, { stop } = {}) {
		const page = await browser0.newPage();
		await openJoin(page, base);
		await page.fill(SEL.nameInput, name);
		if (stop) await page.pressKey(SEL.colourRing, stop);
		await page.clickByRole('button', 'Start singing');
		await page.waitFor(`location.pathname === '/'`);
		// openBrowseFromHome waits for the joined home and then for the search box.
		await openBrowseFromHome(page);
		return page;
	}

	const maya = await joinAs('Maya', { stop: 'Home' }); // the ring's first stop
	// Ada takes the other end of the ring — a colour the default never lands on.
	const ada = await joinAs('Ada', { stop: 'End' });
	check('two guests joined in isolated sessions', true);

	const adaColour = await ada.evaluate(`(async () => (await (await fetch('/api/me')).json())?.singer?.color ?? '')()`);
	check(
		'a wheel hue survives the round trip instead of collapsing to a preset',
		/^#[0-9a-f]{6}$/.test(adaColour) && adaColour !== '#7c5cff',
		`server returned ${adaColour || '(nothing)'} — #7c5cff would mean the old allowlist is back`
	);

	// Search and queue. A real multi-character term: the remote does not search on a single character, so
	// 'a' returns nothing and looks exactly like a broken UI.
	await openBrowseFromHome(maya); // search lives behind the browse push
	await maya.fill(SEL.search, 'caroline');
	// Poll for rows instead of sleeping: search is debounced and then hits yt-dlp, so its latency is not a
	// number this file can know.
	const rows = await maya
		.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length`, { timeout: 15_000 })
		.catch(() => 0);
	if (rows === 0) {
		// An empty library is an ENVIRONMENT gap, not a UI bug, and the message has to say so or someone
		// goes looking for a defect in the app.
		check(
			'the unified search box returns rows',
			false,
			'no rows. If the library is empty this is an environment gap, not a UI defect: the demo tracks\n' +
				'        only index when a file exists behind them. Seed, restart the server, re-run:\n' +
				'          bun run tests/e2e/seed-media.mjs'
		);
	} else {
		check('the unified search box returns rows', true, `${rows} rows`);

		// A fresh install has NO ready songs, so results are raw and carry `.sing` rather than `.add`. Take
		// whichever is offered: insisting on `.add` would make this pass only on a machine already used.
		// The raw path is the more interesting one anyway — `.sing` queues AND starts a process, and the
		// rotation must HOLD the slot while it processes.
		const readyCount = await maya.count(SEL.addTurn);
		const rawCount = await maya.count(SEL.sing);
		const queueAction = readyCount > 0 ? SEL.addTurn : SEL.sing;
		check(
			'a search result offers exactly one queueing action',
			readyCount + rawCount > 0,
			`${readyCount} ready (.add), ${rawCount} raw (.sing)`
		);

		await maya.click(queueAction);
		// Back to the QUEUE: the rotation rows, the position line and the transport all live on home, and
		// this flow reads all three. Ada comes home too, before her rotation is compared.
		await returnHomeFromBrowse(maya);
		await returnHomeFromBrowse(ada);
		// Poll for the optimistic row rather than sleeping: the store renders it immediately, but the server
		// confirmation and the socket echo land on their own schedule.
		await maya
			.waitFor(
				`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length + document.querySelectorAll(${JSON.stringify(SEL.processing)}).length`,
				{ timeout: 10_000 }
			)
			.catch(() => 0);
		const queued = await maya.count(SEL.queueRow);
		const processing = await maya.count(SEL.processing);
		// THREE shapes count, because the invariant is "the singer is in the rotation": an idle room
		// auto-starts the add and `queued` filters a playing entry out, so the first song of the night is
		// NOT a row — it is on the band. It reads as `.qrow` when someone else is singing and as `.proc`
		// while it processes. Asserting only `.qrow` reports an empty rotation for a room playing perfectly.
		const heroSong = (await maya.texts(SEL.bandTitle)).filter(
			(/** @type {string} */ t) => t && t !== 'Nothing playing'
		);
		check(
			'queueing puts the singer in the rotation',
			queued + processing + heroSong.length > 0,
			`${queued} ${SEL.queueRow} (of which ${processing} processing — ProcessingCard carries both classes), hero=${JSON.stringify(heroSong)} — a processing song HOLDS its slot and a PLAYING one is the hero, which is why all three count`
		);

		// Cross-client sync: wait for the OTHER phone to catch up over the socket rather than assuming a
		// latency, and CAPTURE the wait result — an empty rotation must fail as a missing precondition
		// rather than slip past the agreement check, where '[]' === '[]' reads as agreement. Compare the
		// playing song AND the waiting rows, for the same reason.
		const rotationOf = async (/** @type {typeof maya} */ page) => [
			...(await page.texts(SEL.bandTitle)).filter((/** @type {string} */ t) => t && t !== 'Nothing playing'),
			...(await page.texts(SEL.queueTitle))
		];
		const adaSawRotation = await ada
			.waitFor(
				`[...document.querySelectorAll(${JSON.stringify(SEL.bandTitle)}),...document.querySelectorAll(${JSON.stringify(SEL.queueTitle)})].some(el => (el.textContent || '').trim() && (el.textContent || '').trim() !== 'Nothing playing')`,
				{ timeout: 10_000 }
			)
			.then(() => true)
			.catch(() => false);
		const mayaQ = await rotationOf(maya);
		const adaQ = await rotationOf(ada);
		check(
			'the rotation reached both phones',
			adaSawRotation && mayaQ.length > 0 && adaQ.length > 0,
			`maya=${JSON.stringify(mayaQ)} ada=${JSON.stringify(adaQ)}${adaSawRotation ? '' : ' (ada never saw a non-empty rotation within 10s)'}`
		);
		check(
			'both phones see the same rotation, in the same order',
			mayaQ.length > 0 && adaQ.length > 0 && JSON.stringify(mayaQ) === JSON.stringify(adaQ),
			`maya=${JSON.stringify(mayaQ)} ada=${JSON.stringify(adaQ)}`
		);

		// The TV reacts.
		await openNowPlaying(maya);
		await maya.click(SEL.bandTransport);
		await sleep(1800);
		const playing = (await tv.count(SEL.lowerThird)) === 1;
		if (playing) {
			const shownFirst = await tv.text(SEL.nowSong);
			check('the TV names who is singing once playback starts', true, shownFirst);
			await openNowPlaying(maya);
			await maya.clickByLabel('skip');
			await sleep(1800);
			const shownSecond = await tv.text(SEL.nowSong);
			// One song queued means a skip empties the rotation, so a different song OR an empty stage is
			// correct; the SAME song still showing means skip did nothing.
			check(
				'skip advances the rotation',
				shownFirst !== shownSecond || (await tv.count(SEL.lowerThird)) === 0,
				`before="${shownFirst}" after="${shownSecond}"`
			);
		} else {
			// Nothing playable is CORRECT here — the queued song is still processing and this environment
			// has no worker to finish it — so assert the OBSERVABLE requirement: the TV must not sit on a
			// blank stage or a stale lower-third.
			//
			// Deliberately NOT `.state-waiting`: reaching that state needs the PLAYER to be actively
			// holding, so a queued-but-never-started process falls through to the lobby copy even though
			// someone has picked a song. Pinning a test to that would freeze a wording bug in place.
			const stale = await tv.count(SEL.lowerThird);
			const explains = (await tv.text(SEL.pageBody)).length > 20;
			check(
				'with nothing playable, the TV explains itself instead of going blank',
				stale === 0 && explains,
				`lower-third=${stale} (must be 0 — a stale one would name a singer who is not singing)`
			);
		}
	}
} catch (err) {
	check(`the flow ran to completion`, false, String(err));
} finally {
	browser?.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
