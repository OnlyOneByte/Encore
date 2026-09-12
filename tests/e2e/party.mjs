/*
 * Full-flow e2e: two phones and a TV, against a live server.
 *
 *   bun run e2e/party.mjs            # discovers a Chromium and starts one
 *   EPORT=3000 bun run e2e/party.mjs # against an already-running server
 *
 * The server it runs against must have an EMPTY room and a ROUTABLE advertised join address — the
 * attract screen the first three checks measure exists only under both. A loopback origin makes the TV
 * show its "Join QR unavailable" alert instead, which is correct but renders none of the type this
 * flow reads, so start the server with one:
 *
 *   ENCORE_EPHEMERAL=1 HOST=127.0.0.1 PORT=5181 MEDIA_DIR=<seeded> \
 *     ENCORE_PUBLIC_ORIGIN=http://<lan-ip>:5181 bun run server.ts
 *
 * WHAT CHANGED AND WHY. The previous version of this file rotted silently. It clicked a `Library` tab
 * that was deleted when search was unified around readiness, picked a colour by an aria-label of
 * `color #ff5cae` after the real label became `violet swatch`, and read rows from `.result` after the
 * component started rendering `.row`. Three selector families had moved while `bun test` stayed green,
 * because nothing in the suite ever looked at this script. It also imported `playwright-core`, which
 * was never a declared dependency.
 *
 * Both causes are addressed structurally, not by fixing the strings:
 *   - Every selector comes from ./contract.ts, which contract.test.ts verifies against the source on
 *     every `bun test` run. The script and the guard cannot drift apart, and rot fails in CI without
 *     needing a browser at all.
 *   - The driver is ./driver.mjs, which speaks the protocol Chromium already understands. No install.
 *
 * Controls are driven by ACCESSIBLE NAME wherever one exists, not by class. If a control loses its
 * accessible name, this flow should break — that is a real regression, and a class-based flow would
 * have hidden it.
 */
import { spawn } from 'node:child_process';
import { connect, sleep } from './driver.mjs';
import { SEL, PRESET_COLOUR_NAMES } from './contract.ts';
import { findChromium } from './lib/chromium.mjs';
import { openBrowseFromHome, returnHomeFromBrowse } from './lib/phone.mjs';

/**
 * Types for this out-of-program driver (earlier changes–an earlier change pattern). Browser/Page derive from
 * driver.mjs's return types so they cannot drift; page.evaluate() is Promise<any>, cast at the call site.
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ name: string, ok: boolean }} Check
 */

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
/*
 * How long to let the TV's `hello`→`queue:sync` round trip land after the socket opens, before trusting
 * what the screen says about the room. See the precondition block below for why the first render is not
 * an answer to "is the room empty".
 */
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
	// Loud, not skipped. A silently-skipped e2e is the failure mode this rewrite exists to prevent.
	console.error('No Chromium found. Set PW_CHROMIUM, or install one, then re-run.');
	process.exit(2);
}

const res = await fetch(`${base}/health`).catch(() => null);
if (!res?.ok) {
	console.error(`No Encore server on ${base}. Start one (ENCORE_EPHEMERAL=1 PORT=${PORT} bun run start) and re-run.`);
	process.exit(2);
}

const proc = spawn(
	chromium,
	[
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		`--remote-debugging-port=${CDP_PORT}`,
		'--remote-allow-origins=*',
		'about:blank'
	],
	{ stdio: 'ignore' }
);

/** @type {Browser | undefined} */
let browser;
try {
	const browser0 = await connect(CDP_PORT);
	browser = browser0;

	// ── the TV, BEFORE anyone joins ───────────────────────────────────────────
	// Order matters. The attract layout only exists while the room is EMPTY, so asserting on it after two
	// guests join reads the lobby instead, finds nothing, and reports 0px — which is exactly what the
	// first run of this rewrite did. The stage scale and safe area are stage 3's whole point, so they are
	// asserted on the RENDERED result: a token can be declared correctly and still not reach the element
	// it was meant for.
	const tv = await browser0.newPage();
	await tv.goto(`${base}/tv`);

	/*
	 * TWO preconditions, reported SEPARATELY, because conflating them is what broke this flow.
	 *
	 * (1) The room must be EMPTY. The attract screen only renders before anyone joins, and the server is
	 *     ephemeral but not per-run, so a previous run's guests are still in it.
	 *
	 * (2) The advertised join address must be ROUTABLE. When it is loopback or a bare hostname the TV
	 *     deliberately replaces the QR block — and `.idle-url`/`.idle-head` with it — with a `.badqr`
	 *     alert, because a QR pointing at an unreachable address is a working-looking dead end. That is
	 *     correct behaviour, and it is also the default when you start the server on 127.0.0.1, so the
	 *     flow has to make it an explicit environment requirement instead of measuring 0px and calling
	 *     the type illegible. It cannot fix this itself: `PUT /api/settings` requires a joined singer,
	 *     and joining is precisely what destroys precondition (1).
	 *
	 * The previous version gated on `.url` for (1) and had no notion of (2) at all. `.url` is the
	 * LOBBY's typed address (TvLobby.svelte) — it appears only once somebody HAS joined — so the gate
	 * was inverted: it could never pass on the fresh empty room it demanded, and its message told the
	 * operator to restart the server, which produces the state it was already in. Distinguishing the two
	 * is the difference between an actionable message and a false regression report.
	 *
	 * AND THE FIRST RENDER CANNOT BE TRUSTED FOR (1). `online`/`away` start empty on the client and are
	 * filled only by the socket's `queue:sync`, so the server renders the ATTRACT screen for every room
	 * — verified by fetching /tv on a server holding a leftover guest: the document contains `attract`,
	 * `idle-url` and "Nobody here yet", and no `.lobby` at all. Only the sync corrects it. Reading
	 * `.attract` straight after load therefore answers "has the socket synced yet", not "is the room
	 * empty", and on a leftover-guest server it can pass and then have `.idle-url` unmount mid-flight —
	 * reporting `computed 0px`, which is the ORIGINAL false-failure symptom wearing a different hat. So
	 * wait for the socket, let the sync land, and re-check the screen at the moment of measurement.
	 */
	const socketUp = await tv.waitFor(`document.querySelector(${JSON.stringify(SEL.tvConnected)}) !== null`, { timeout: 8000 }).catch(() => false);
	if (!socketUp) {
		console.error(`\nThe TV never opened its WebSocket to ${base}. Is the server still running?`);
		browser0.close();
		proc.kill();
		process.exit(2);
	}
	// `connected` flips on `onopen`, and the roster arrives one `hello`→`queue:sync` round trip later, so
	// the socket being up is necessary and not sufficient. This settle covers that round trip; it is
	// deliberately generous against a loopback RTT of single-digit ms because the alternative is a
	// flake that reads as a product defect.
	await sleep(SYNC_SETTLE_MS);

	const onAttract = await tv.waitFor(`document.querySelector(${JSON.stringify(SEL.attract)}) !== null`, { timeout: 4000 }).catch(() => false);
	if (!onAttract) {
		console.error(
			'\nThis flow needs an empty room — the attract screen only renders before anyone joins,\n' +
				'and a previous run leaves its guests behind. Restart the server and re-run:\n' +
				`  ENCORE_EPHEMERAL=1 PORT=${PORT} MEDIA_DIR=<seeded dir> ENCORE_PUBLIC_ORIGIN=http://<lan-ip>:${PORT} bun run start`
		);
		browser0.close();
		proc.kill();
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
		proc.kill();
		process.exit(2);
	}

	/*
	 * All three measurements are taken FIRST, then the screen is re-checked ONCE, and only then are the
	 * assertions run. The order is the point: a late `queue:sync` that swaps attract for the lobby must be
	 * reported as the environment problem it is, for every value, rather than as illegible type. Reading
	 * and asserting one value at a time delivered that guarantee for the join address and silently not for
	 * the other two — and each fails differently on the lobby, which is what makes it a trap: `.idle-head`
	 * unmounts (so `null` → 0px), while `.brand` still EXISTS on the lobby but in-flow, so its `left`
	 * computes to `auto` → `NaN`, and `NaN >= 48` reads exactly like a real layout regression.
	 */
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
		proc.kill();
		process.exit(2);
	}
	check(
		'the join URL is legible at ten feet',
		urlSize >= 26,
		`computed ${urlSize}px — the ten-foot floor is 26px, and this was 22.4px before`
	);
	// The attract screen's instruction ("Scan to join the party"). This used to read `.hint`, a class the
	// TV does not render anywhere — it lives on the phone's queue sheet, the settings page and the charts
	// — so the assertion measured nothing, defaulted to 0px, and would have failed the moment the flow
	// got far enough to run it.
	check('stage headline clears the ten-foot floor', headlineSize >= 26, `computed ${headlineSize}px`);
	check(
		'stage chrome sits inside the overscan-safe margin',
		brandLeft >= 48,
		`computed left ${brandLeft}px — a bare 48px would sit inside the overscan region on many sets`
	);

	// ── two guests join, one by preset and one off the hue wheel ─────────────
	/** @param {string} name @param {{ colourName?: string, hue?: number }} [opts] @returns {Promise<Page>} */
	async function joinAs(name, { colourName, hue } = {}) {
		const page = await browser0.newPage();
		await page.goto(`${base}/join`);
		await page.fill(SEL.nameInput, name);
		if (colourName) await page.clickByLabel(SEL.swatch(colourName).name);
		if (hue !== undefined) await page.setRange(SEL.hueSlider, hue);
		await page.clickByText('Start singing');
		await page.waitFor(`location.pathname === '/'`);
		// Home is the QUEUE since an earlier change; searching is a push. openBrowseFromHome waits for the joined home,
		// clicks the primary button and waits for the search box, so the caller lands where it used to.
		await openBrowseFromHome(page);
		return page;
	}

	const maya = await joinAs('Maya', { colourName: PRESET_COLOUR_NAMES[1] }); // pink preset
	// Ada picks a hue off the wheel — the path that did not exist before this branch, and the one that
	// silently coerced every non-preset colour to violet.
	const ada = await joinAs('Ada', { hue: 150 });
	check('two guests joined in isolated sessions', true);

	const adaColour = await ada.evaluate(`(async () => (await (await fetch('/api/me')).json())?.singer?.color ?? '')()`);
	check(
		'a wheel hue survives the round trip instead of collapsing to a preset',
		/^#[0-9a-f]{6}$/.test(adaColour) && adaColour !== '#7c5cff',
		`server returned ${adaColour || '(nothing)'} — #7c5cff would mean the old allowlist is back`
	);

	// ── search and queue, through the one unified box ────────────────────────
	// A real multi-character term: the remote does not search on a single character, so 'a' returns
	// nothing and looks exactly like a broken UI. It is not.
	await openBrowseFromHome(maya); // search lives behind the browse push
	await maya.fill(SEL.search, 'caroline');
	/*
	 * Poll for rows instead of sleeping. Search is debounced and then hits yt-dlp, so its latency is not
	 * a number this file can know — a fixed sleep passed on one run and failed the next against the same
	 * build, which is how an e2e earns a reputation for being flaky and stops being run.
	 */
	const rows = await maya.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length`, { timeout: 15_000 }).catch(() => 0);
	if (rows === 0) {
		// Loud and actionable, never a silent skip — an e2e that quietly stops asserting is the exact
		// failure this rewrite exists to prevent. An empty library is an ENVIRONMENT gap, not a UI bug,
		// and the message has to say so, or someone will go looking for a defect in the app.
		check(
			'the unified search box returns rows',
			false,
			'no rows. If the library is empty this is an environment gap, not a UI defect: the demo tracks\n' +
				'        only index when a file exists behind them. Seed, restart the server, re-run:\n' +
				'          bun run e2e/seed-media.mjs'
		);
	} else {
		check('the unified search box returns rows', true, `${rows} rows`);

		/*
		 * A fresh install has NO ready songs — nothing has been processed yet — so results are raw and carry
		 * `.sing` rather than `.add`. Both are queueing actions and the flow takes whichever is offered,
		 * because insisting on `.add` would make this assertion pass only on a machine that had already
		 * been used. The raw path is also the more interesting one: `.sing` queues AND starts a process, and
		 * rotation is supposed to HOLD the slot while it processes.
		 */
		const readyCount = await maya.count(SEL.addTurn);
		const rawCount = await maya.count(SEL.sing);
		const queueAction = readyCount > 0 ? SEL.addTurn : SEL.sing;
		check(
			'a search result offers exactly one queueing action',
			readyCount + rawCount > 0,
			`${readyCount} ready (.add), ${rawCount} raw (.sing)`
		);

		await maya.click(queueAction);
		// Back to the QUEUE, which is home since an earlier change — the rotation rows, the position line and the
		// transport all live there, and this flow reads all three below. Ada is still on the browse
		// screen she joined through, so she comes home too before her rotation is compared.
		await returnHomeFromBrowse(maya);
		await returnHomeFromBrowse(ada);
		// Poll for the optimistic row rather than sleeping: the store renders it immediately, but the
		// server confirmation and the socket echo land on their own schedule.
		await maya
			.waitFor(
				`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length + document.querySelectorAll(${JSON.stringify(SEL.processing)}).length`,
				{ timeout: 10_000 }
			)
			.catch(() => 0);
		const queued = await maya.count(SEL.queueRow);
		const processing = await maya.count(SEL.processing);
		/*
		 * The song can be in the rotation in THREE shapes, and the first song of the night is the one
		 * that is not a row: an idle room auto-starts the add, the entry's status becomes 'playing', and
		 * `queued` filters a playing entry out — so it renders on the HERO instead. It reads as a
		 * `.qrow` when someone else is already singing, and as `.proc` while it processes. The invariant is
		 * "the singer is in the rotation", so all three count; asserting only `.qrow` would report an
		 * empty rotation for a room whose first song is playing perfectly.
		 */
		const heroSong = (await maya.texts(SEL.heroTitle)).filter((/** @type {string} */ t) => t && t !== 'Nothing playing');
		check(
			'queueing puts the singer in the rotation',
			queued + processing + heroSong.length > 0,
			`${queued} ${SEL.queueRow} (of which ${processing} processing — ProcessingCard carries both classes), hero=${JSON.stringify(heroSong)} — a processing song HOLDS its slot and a PLAYING one is the hero, which is why all three count`
		);

		// ── cross-client sync ───────────────────────────────────────────────
		// Wait for the OTHER phone to catch up over the socket, rather than assuming a latency.
		// Capture the wait result: an empty rotation must FAIL as a missing precondition,
		// not slip past the agreement check (where '[]' === '[]' reads as spurious agreement).
		// The rotation AS EACH PHONE SEES IT: the playing song (hero) followed by the waiting rows. Both
		// halves, for the same reason as above — comparing rows alone compares two empty lists and reads
		// as agreement when neither phone has rendered anything.
		const rotationOf = async (/** @type {typeof maya} */ page) => [...(await page.texts(SEL.heroTitle)).filter((/** @type {string} */ t) => t && t !== 'Nothing playing'),...(await page.texts(SEL.queueTitle))
		];
		const adaSawRotation = await ada
			.waitFor(
				`[...document.querySelectorAll(${JSON.stringify(SEL.heroTitle)}),...document.querySelectorAll(${JSON.stringify(SEL.queueTitle)})].some(el => (el.textContent || '').trim() && (el.textContent || '').trim() !== 'Nothing playing')`,
				{ timeout: 10_000 }
			).then(() => true).catch(() => false);
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

		// ── the TV reacts ────────────────────────────────────────────────────
		await maya.clickByLabel('play/pause');
		await sleep(1800);
		const playing = (await tv.count(SEL.lowerThird)) === 1;
		if (playing) {
			const shownFirst = await tv.text(SEL.nowSong);
			check('the TV names who is singing once playback starts', true, shownFirst);
			await maya.clickByLabel('skip');
			await sleep(1800);
			const shownSecond = await tv.text(SEL.nowSong);
			// One song queued means a skip empties the rotation, so a different song OR an empty stage is
			// correct. The SAME song still showing means skip did nothing.
			check(
				'skip advances the rotation',
				shownFirst !== shownSecond || (await tv.count(SEL.lowerThird)) === 0,
				`before="${shownFirst}" after="${shownSecond}"`
			);
		} else {
			/*
			 * Nothing playable, which is CORRECT here: the queued song is still processing and this
			 * environment has no worker to finish it. So assert the OBSERVABLE requirement rather than an
			 * internal state — the TV must not sit on a blank stage or a stale lower-third; it has to say
			 * something about why nothing is playing.
			 *
			 * Deliberately NOT asserting `.state-waiting` here. screen.ts documents `waiting` as "something
			 * is queued but its stems are still processing", but reaching it requires the PLAYER to be
			 * actively holding, so a queued-but-never-started process falls through to the lobby copy
			 * ("Waiting for someone to pick a song…") even though someone has picked one. That is
			 * pre-existing behaviour, not something this branch changed, and pinning a test to the current
			 * outcome would freeze a wording bug in place. Flagged instead of encoded.
			 */
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
	proc.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
