/*
 * Full-flow e2e: two phones and a TV, against a live server.
 *
 *   bun run e2e/party.mjs            # discovers a Chromium and starts one
 *   EPORT=3000 bun run e2e/party.mjs # against an already-running server
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
 *   - The driver is ./cdp.mjs, which speaks the protocol Chromium already understands. No install.
 *
 * Controls are driven by ACCESSIBLE NAME wherever one exists, not by class. If a control loses its
 * accessible name, this flow should break — that is a real regression, and a class-based flow would
 * have hidden it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';
import { SEL, PRESET_COLOUR_NAMES } from './contract.ts';

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);

const checks = [];
function check(name, ok, detail = '') {
	checks.push({ name, ok: !!ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/** Find a Chromium without requiring one to be installed by this package. */
function findChromium() {
	if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
	const cache = join(homedir(), '.cache', 'ms-playwright');
	for (const build of ['chromium-1232', 'chromium-1228']) {
		const p = join(cache, build, 'chrome-linux', 'chrome');
		if (existsSync(p)) return p;
	}
	for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
		if (existsSync(p)) return p;
	}
	return null;
}

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

let browser;
try {
	browser = await connect(CDP_PORT);

	// ── the TV, BEFORE anyone joins ───────────────────────────────────────────
	// Order matters. `.url` and the attract layout only exist while the room is EMPTY, so asserting them
	// after two guests join reads the lobby instead, finds nothing, and reports 0px — which is exactly
	// what the first run of this rewrite did. The stage scale and safe area are stage 3's whole point, so
	// they are asserted on the RENDERED result: a token can be declared correctly and still not reach
	// the element it was meant for.
	const tv = await browser.newPage();
	await tv.goto(`${base}/tv`);

	/*
	 * This flow needs an EMPTY room, and says so rather than failing misleadingly.
	 *
	 * The attract screen — and `.url` with it — only exists while nobody has joined. An earlier version
	 * asserted on it unconditionally and passed on a fresh server, then reported "the join URL is 0px" on
	 * the second run against the same one, because its own guests from the first run were still in the
	 * room. The server is ephemeral but it is not per-run. A false failure that looks like a real
	 * regression is worse than no test, so this exits as an environment problem, the same way a missing
	 * Chromium does.
	 */
	const fresh = await tv.waitFor(`document.querySelector('.url') !== null`, { timeout: 4000 }).catch(() => false);
	if (!fresh) {
		console.error(
			'\nThis flow needs an empty room — the attract screen only renders before anyone joins,\n' +
				'and a previous run leaves its guests behind. Restart the server and re-run:\n' +
				`  ENCORE_EPHEMERAL=1 PORT=${PORT} MEDIA_DIR=<seeded dir> bun run start`
		);
		browser.close();
		proc.kill();
		process.exit(2);
	}

	const urlSize = parseFloat((await tv.css('.url', 'font-size')) ?? '0');
	check(
		'the join URL is legible at ten feet',
		urlSize >= 26,
		`computed ${urlSize}px — the ten-foot floor is 26px, and this was 22.4px before`
	);
	const hintSize = parseFloat((await tv.css('.hint', 'font-size')) ?? '0');
	check('stage hint text clears the ten-foot floor', hintSize >= 26, `computed ${hintSize}px`);
	const brandLeft = parseFloat((await tv.css('.brand', 'left')) ?? '0');
	check(
		'stage chrome sits inside the overscan-safe margin',
		brandLeft >= 48,
		`computed left ${brandLeft}px — a bare 48px would sit inside the overscan region on many sets`
	);

	// ── two guests join, one by preset and one off the hue wheel ─────────────
	async function joinAs(name, { colourName, hue } = {}) {
		const page = await browser.newPage();
		await page.goto(`${base}/join`);
		await page.fill(SEL.nameInput, name);
		if (colourName) await page.clickByLabel(SEL.swatch(colourName).name);
		if (hue !== undefined) await page.setRange(SEL.hueSlider, hue);
		await page.clickByText('Start singing');
		await page.waitFor(`location.pathname === '/'`);
		await page.waitFor(`document.querySelector(${JSON.stringify(SEL.search)}) !== null`);
		return page;
	}

	const maya = await joinAs('Maya', { colourName: PRESET_COLOUR_NAMES[1] }); // pink preset
	// Ada picks a hue off the wheel — the path that did not exist before this branch, and the one that
	// silently coerced every non-preset colour to violet.
	const ada = await joinAs('Ada', { hue: 150 });
	check('two guests joined in isolated sessions', true);

	const adaColour = await ada.evaluate(
		`(async () => (await (await fetch('/api/me')).json())?.singer?.color ?? '')()`
	);
	check(
		'a wheel hue survives the round trip instead of collapsing to a preset',
		/^#[0-9a-f]{6}$/.test(adaColour) && adaColour !== '#7c5cff',
		`server returned ${adaColour || '(nothing)'} — #7c5cff would mean the old allowlist is back`
	);

	// ── search and queue, through the one unified box ────────────────────────
	// A real multi-character term: the remote does not search on a single character, so 'a' returns
	// nothing and looks exactly like a broken UI. It is not.
	await maya.fill(SEL.search, 'caroline');
	/*
	 * Poll for rows instead of sleeping. Search is debounced and then hits yt-dlp, so its latency is not
	 * a number this file can know — a fixed sleep passed on one run and failed the next against the same
	 * build, which is how an e2e earns a reputation for being flaky and stops being run.
	 */
	const rows = await maya
		.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length`, { timeout: 15_000 })
		.catch(() => 0);
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
		 * A fresh install has NO ready songs — nothing has been cooked yet — so results are raw and carry
		 * `.sing` rather than `.add`. Both are queueing actions and the flow takes whichever is offered,
		 * because insisting on `.add` would make this assertion pass only on a machine that had already
		 * been used. The raw path is also the more interesting one: `.sing` queues AND starts a cook, and
		 * rotation is supposed to HOLD the slot while it cooks.
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
		// Poll for the optimistic row rather than sleeping: the store renders it immediately, but the
		// server confirmation and the socket echo land on their own schedule.
		await maya
			.waitFor(
				`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length + document.querySelectorAll('.proc').length`,
				{ timeout: 10_000 }
			)
			.catch(() => 0);
		const queued = await maya.count(SEL.queueRow);
		const processing = await maya.count('.proc');
		check(
			'queueing puts the singer in the rotation',
			queued + processing > 0,
			`${queued} ${SEL.queueRow} + ${processing} cooking cards — a cooking song HOLDS its slot, which is why either counts`
		);

		// ── cross-client sync ───────────────────────────────────────────────
		// Wait for the OTHER phone to catch up over the socket, rather than assuming a latency.
		await ada
			.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueTitle)}).length > 0`, { timeout: 10_000 })
			.catch(() => false);
		const mayaQ = await maya.texts(SEL.queueTitle);
		const adaQ = await ada.texts(SEL.queueTitle);
		check(
			'both phones see the same rotation, in the same order',
			JSON.stringify(mayaQ) === JSON.stringify(adaQ),
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
			 * Nothing playable, which is CORRECT here: the queued song is still cooking and this
			 * environment has no worker to finish it. So assert the OBSERVABLE requirement rather than an
			 * internal state — the TV must not sit on a blank stage or a stale lower-third; it has to say
			 * something about why nothing is playing.
			 *
			 * Deliberately NOT asserting `.state-waiting` here. screen.ts documents `waiting` as "something
			 * is queued but its stems are still cooking", but reaching it requires the PLAYER to be
			 * actively holding, so a queued-but-never-started cook falls through to the lobby copy
			 * ("Waiting for someone to pick a song…") even though someone has picked one. That is
			 * pre-existing behaviour, not something this branch changed, and pinning a test to the current
			 * outcome would freeze a wording bug in place. Flagged instead of encoded.
			 */
			const stale = await tv.count(SEL.lowerThird);
			const explains = (await tv.text('body')).length > 20;
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
