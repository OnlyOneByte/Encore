/*
 * Capture every UI surface, driven into each state rather than photographed as it happens to load.
 *
 *   bun run e2e:seed                                   # or point MEDIA_DIR at a real cooked library
 *   ENCORE_EPHEMERAL=1 PORT=3500 MEDIA_DIR=<media> bun run start
 *   EPORT=3500 bun run e2e/capture.mjs [outDir]
 *
 * This exists because a screenshot of a default page proves almost nothing: the states worth looking
 * at are the ones a guest actually hits — a queue with a song cooking in it, the sheet pulled up, the
 * TV once someone has joined, the words moving under the ball. Each frame below is reached by driving
 * the real app through the real controls, so what you see is what a guest would see.
 *
 * TWO THINGS THAT MAKE THE INTERESTING FRAMES POSSIBLE, both easy to lose:
 *
 *   1. `--autoplay-policy=no-user-gesture-required`. Without it the <video> never starts, so every
 *      playing-state frame silently degrades to the lobby and the whole lyrics section captures
 *      nothing. There is no error — you just get the wrong screen 20 times.
 *   2. A media volume with REAL cooked songs (stems + lyrics + songProfile). `e2e:seed` writes
 *      undecodable placeholders, which is enough for search/queue/rotation but NOT for playback: the
 *      song will queue, fail to decode, and the TV will correctly show its cannot-play state. Point
 *      MEDIA_DIR at a genuinely cooked library for the playing frames, and expect this script to skip
 *      them (loudly) when nothing is ready to sing.
 *
 * The TV is captured at 1920x1080 because its type scale is vh-relative: a frame taken at the wrong
 * height is measuring a different design.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';
import { SEL, PRESET_COLOUR_NAMES } from './contract.ts';
import { findChromium } from './lib/chromium.mjs';
import { openBrowseFromHome, returnHomeFromBrowse } from './lib/phone.mjs';

/**
 * Types for this out-of-program driver, which runs under tsconfig.e2e.json (issue #564, following the
 * #553/#557–#563 pattern). Browser/Page are derived from cdp.mjs's own return types (#553) so they
 * cannot drift from the driver. page.evaluate() comes back Promise<any>, so DOM-shaped results are
 * cast at the call site.
 *
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 */

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;
const OUT = process.argv[2] ?? join(import.meta.dir, '..', '..', '..', 'docs', 'mocks');
const CDP_PORT = Number(process.env.CDP_PORT ?? 9500);
/*
 * The id half of `<id>-<what>-eyeson.png`. `tour` = this full-surface tour, as opposed to the older
 * per-milestone ids (m0c5-, b7c4-, ds-…) that record the work which first produced a frame.
 */
const ID = process.env.CAPTURE_ID ?? 'tour';

/** @type {readonly [number, number]} */
const PHONE = [430, 860];
/** @type {readonly [number, number]} */
const TV = [1920, 1080];

const chromium = findChromium();
if (!chromium) {
	console.error('No Chromium found. Set PW_CHROMIUM and re-run.');
	process.exit(2);
}
if (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
	console.error(`No Encore server on ${base}.`);
	process.exit(2);
}

mkdirSync(OUT, { recursive: true });
/** @type {{ name: string, note: string }[]} */
const shots = [];
/** @type {{ name: string, why: string }[]} */
const skipped = [];

const proc = spawn(
	chromium,
	[
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		'--hide-scrollbars',
		// see the header note — without these the playing frames capture the lobby instead
		'--autoplay-policy=no-user-gesture-required',
		'--mute-audio',
		`--remote-debugging-port=${CDP_PORT}`,
		'--remote-allow-origins=*',
		'about:blank'
	],
	{ stdio: 'ignore' }
);

/** @param {Page} page @param {string} name @param {string} note */
async function shoot(page, name, note) {
	const path = join(OUT, `${ID}-${name}-eyeson.png`);
	await page.screenshot(path);
	shots.push({ name, note });
	console.log(`  ✓ ${name} — ${note}`);
}

/*
 * One frame must not be able to cost the other forty.
 *
 * A capture run is a long chain of stateful steps, and the failure that actually happens is a single
 * control moving — which used to abort the run and leave the whole set half-regenerated and silently
 * mixed between old and new. Each frame is therefore attempted independently and a failure is
 * recorded and reported at the end, so one broken step yields one missing frame plus a named reason.
 */
/** @param {string} name @param {() => Promise<void> | void} fn */
async function frame(name, fn) {
	try {
		await fn();
	} catch (err) {
		skipped.push({ name, why: String(err).split('\n')[0] });
		console.log(`  ✗ ${name} — SKIPPED: ${String(err).split('\n')[0]}`);
	}
}

/** Change a room/global setting through its real <select>, then let the socket carry it to the TV. */
/** @param {Page} page @param {string} id @param {string} value @param {number} [settleMs] */
async function setSetting(page, id, value, settleMs = 700) {
	await page.fill(SEL.setting(id), value);
	await sleep(settleMs);
}

/*
 * Select one of the settings page's three scopes, and WAIT for it rather than sleeping at it.
 *
 * Driven through the real tab (not by navigating to `?tab=`) so the control that gates every setting
 * below is itself exercised on every run. The wait is on `aria-selected`, because that attribute is
 * both the thing a screen reader reads and the thing that flips only once the panel has actually
 * swapped — a fixed sleep here is how a frame ends up shot against the outgoing tab.
 */
/** @param {Page} page @param {string} id */
async function scope(page, id) {
	await page.click(SEL.settingsTab(id));
	await page.waitFor(
		`document.querySelector(${JSON.stringify(SEL.settingsTab(id))})?.getAttribute('aria-selected') === 'true'`
	);
	await sleep(350);
}

/*
 * Size the viewport to the page's own content, so a short page is not mostly empty background.
 *
 * The desktop pages (/stats, /metrics, the gallery) vary enormously in height with how much data the
 * instance has, and a fixed tall viewport turns a 660px page into a frame that is two thirds black —
 * which reads as a rendering bug rather than a small library. Capped at 2000px because a frame past
 * that cannot be read back by the agent tooling that reviews these (see docs/mocks/README.md).
 */
/** @param {Page} page @param {number} width @param {{ min?: number, max?: number, pad?: number }} [opts] */
async function fitViewport(page, width, { min = 600, max = 2000, pad = 40 } = {}) {
	await page.viewport(width, min, 1);
	await sleep(300);
	const h = await page.evaluate(`Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)`);
	const height = Math.max(min, Math.min(max, Math.ceil(h) + pad));
	await page.viewport(width, height, 1);
	await sleep(250);
	return height;
}

/*
 * Start the TV's media element by hand.
 *
 * NOT a shortcut around the app: the phone has already sent the real play command and the room is in
 * its playing state by the time this runs. This exists purely because headless Chromium refuses to
 * start an UNMUTED element without a user gesture, so `TvPlayer`'s own `play()` is rejected and the
 * <video> sits at 0 while the room believes it is playing. That is a uniquely nasty failure to debug
 * from screenshots, because every frame still looks plausible — the lower third is up, the lyrics are
 * rendered — and only the position gives it away: the reel is frozen on the song's FIRST line in
 * every single frame. `--autoplay-policy=no-user-gesture-required` is necessary but not sufficient.
 *
 * The lyrics reel is driven by the element's own timeupdate (via TvPlayer's onposition telemetry),
 * so nothing about the words moves until this succeeds.
 */
/** @param {Page} tv @returns {Promise<string>} */
async function kickPlayback(tv) {
	const report = await tv.evaluate(`(async () => {
    const out = [];
    for (const v of document.querySelectorAll(${JSON.stringify(SEL.mediaEl)})) {
      if (!v.currentSrc) continue;
      try { await v.play(); out.push('started'); } catch (e) { out.push('rejected:' + e.name); }
    }
    return out.join(',') || 'no media element with a src';
  })()`);
	return report;
}

/** Is the TV's media actually moving? The only trustworthy answer is: look twice.
 * @param {Page} tv @param {number} [overMs] @returns {Promise<boolean>} */
async function positionAdvancing(tv, overMs = 1600) {
	const read = () =>
		// `video, audio` — the master is an <audio> (TvPlayer plays an instrumental, which has no picture).
		// Pinned to a bare 'video' this read returned -1 forever, which reads as "not advancing" and would
		// quietly cost every playing-state frame in the gallery.
		tv.evaluate(
			`(() => { const v = document.querySelector(${JSON.stringify(SEL.mediaEl)}); return v ? v.currentTime : -1; })()`
		);
	const a = await read();
	await sleep(overMs);
	const b = await read();
	return b > a + 0.2;
}

/*
 * Get the room genuinely singing, and PROVE it rather than assume it.
 *
 * The bug this replaces: the capture clicked play/pause exactly once and treated the lower third
 * appearing as success. But the lower third only means a song is CURRENT, not that it is moving — and
 * because the room starts the song itself when one is queued with a TV attached, that single click was
 * landing on an already-playing room and PAUSING it. Every downstream frame then showed a reel frozen
 * on line one, silently, including all twenty style variants. So: toggle, kick the element past the
 * headless autoplay block, and only accept it once the position has actually moved.
 */
/** @param {Page} tv @param {Page} phone @param {{ attempts?: number }} [opts] @returns {Promise<boolean>} */
async function ensurePlaying(tv, phone, { attempts = 3 } = {}) {
	for (let i = 0; i < attempts; i++) {
		await kickPlayback(tv);
		if (await positionAdvancing(tv)) return true;
		await phone.clickByLabel(SEL.play.name);
		await sleep(600);
		await kickPlayback(tv);
		if (await positionAdvancing(tv)) return true;
	}
	return false;
}

/** @type {Browser | undefined} */
let browser;
try {
	const browser0 = await connect(CDP_PORT);
	browser = browser0;

	// ── TV first: attract only exists while the room is empty ─────────────────
	const tv = await browser0.newPage();
	await tv.viewport(...TV, 1);
	await tv.goto(`${base}/tv`);
	/*
	 * Wait on the QR's ALT TEXT, not a class. The previous version of this script waited for `.url`,
	 * which no longer exists (the short URL is `.u` inside `.hero`/`.corner` now) — so the very first
	 * step timed out and took the whole run with it. The alt text is the thing a user is promised;
	 * it moves far less often than the presentational class beside it. It is also registered in
	 * contract.ts, so if it does move, `bun test` says so before a capture run does.
	 */
	await tv.waitFor(`document.querySelector(${JSON.stringify(SEL.qrImage)}) !== null`);
	await frame('tv-attract', () => shoot(tv, 'tv-attract', 'nobody here yet — the QR owns the screen'));

	// ── join, both ways of picking a colour ──────────────────────────────────
	const maya = await browser0.newPage();
	await maya.viewport(...PHONE);
	await maya.goto(`${base}/join`);
	await frame('join-presets', () => shoot(maya, 'join-presets', 'presets, with the violet default selected'));

	await frame('join-hue-wheel', async () => {
		await maya.setRange(SEL.hueSlider, 150);
		await sleep(300);
		await shoot(maya, 'join-hue-wheel', 'a hue picked off the wheel — lightness and chroma stay pinned');
	});

	await maya.fill(SEL.nameInput, 'Maya');
	await maya.clickByLabel(SEL.swatch(PRESET_COLOUR_NAMES[1]).name); // pink
	await sleep(250);
	await frame('join-ready', () => shoot(maya, 'join-ready', 'name entered and a preset chosen, submit enabled'));
	await maya.clickByText('Start singing');
	await maya.waitFor(`location.pathname === '/'`);
	await openBrowseFromHome(maya);
	await sleep(700);

	// ── phone remote: the library, then search ───────────────────────────────
	// ── phone remote: the library, then search ───────────────────────────────
	/*
	 * The TV is in its LOBBY state at this exact point and nowhere else in this run: someone is in the
	 * room, but nothing is queued yet. It is one of the four room states the README claims, it is easy
	 * to miss because it exists only in the gap between joining and picking, and it is the screen that
	 * proves the room distinguishes "nobody here" from "nobody has picked yet".
	 */
	await frame('tv-lobby', async () => {
		await sleep(900);
		await shoot(tv, 'tv-lobby', 'someone is here but nothing is queued — the room asks for a pick');
	});

	await frame('phone-library', () =>
		shoot(maya, 'phone-library', 'the library as it opens — cooked songs, newest first')
	);

	await frame('phone-browse', async () => {
		await maya.click(SEL.browseToggle);
		await sleep(500);
		await shoot(maya, 'phone-browse', 'browse behind its disclosure: artist and genre facets');
		await maya.click(SEL.browseToggle); // close it again so it does not shadow later frames
		await sleep(300);
	});

	// Find something actually singable. Everything downstream of here needs one.
	const READY_QUERIES = ['brightside', 'africa', 'take on me', 'zombie'];
	let readyQuery = null;
	for (const q of READY_QUERIES) {
		const res = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
		if (res.ready?.length) {
			readyQuery = q;
			break;
		}
	}

	await frame('phone-search', async () => {
		await openBrowseFromHome(maya); // #832: search lives behind the browse push
		await maya.fill(SEL.search, readyQuery ?? 'caroline');
		await maya.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length`, {
			timeout: 15_000
		});
		await sleep(500);
		await shoot(maya, 'phone-search', 'unified search — one row shape, one action per row, readiness first');
	});

	// ── a second guest, so the roster and cross-client sync are visible ──────
	const ada = await browser0.newPage();
	await ada.viewport(...PHONE);
	await ada.goto(`${base}/join`);
	await ada.fill(SEL.nameInput, 'Ada');
	await ada.setRange(SEL.hueSlider, 210);
	await ada.clickByText('Start singing');
	await ada.waitFor(`location.pathname === '/'`);
	await sleep(800);

	// ── queue it, and start singing ──────────────────────────────────────────
	let playing = false;
	if (readyQuery) {
		await frame('queue+play', async () => {
			await maya.click(SEL.addTurn);
			await maya
				.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`, { timeout: 10_000 })
				.catch(() => 0);
			await sleep(600);
			// The transport is on the now-playing hero since #832 (it used to need the sheet's peek opened
			// with ArrowUp), and the hero is on home — which is also where the queue rows above render.
			await returnHomeFromBrowse(maya);
			await sleep(400);
			await maya.clickByLabel(SEL.play.name);
			/*
			 * The song-intro card lives in the gap between "the player is ready" and "the song is
			 * playing", so it has to be caught here — before the position check below, which by
			 * definition cannot pass while the room is still holding on the intro. It is time-boxed to
			 * the room's songIntroMs (2.5s by default, and `0` turns it off entirely), so this is
			 * best-effort by design: a miss costs one frame and is reported, never the run.
			 */
			await frame('tv-song-intro', async () => {
				await tv.waitFor(`document.querySelector(${JSON.stringify(SEL.stateNext)}) !== null`, {
					timeout: 20_000
				});
				await shoot(tv, 'tv-song-intro', 'the song-intro card names who is up before the music starts');
			});
			// the TV naming a singer means a song is CURRENT — not that it is moving
			await tv.waitFor(`document.querySelector(${JSON.stringify(SEL.lowerThird)}) !== null`, {
				timeout: 25_000
			});
			const moving = await ensurePlaying(tv, maya);
			console.log(`    playback: ${moving ? 'advancing' : 'NOT ADVANCING — playing frames will be wrong'}`);
			playing = moving;
		});
	} else {
		skipped.push({ name: '(playback)', why: 'no song is ready to sing in this media volume' });
		console.log('  ! nothing ready to sing — every playing/lyrics frame will be skipped');
	}

	// Was 'phone-queue-sheet' — the pull-up sheet this frame existed to show is retired from the phone
	// route by #832. The same content is now the home screen itself: hero, position line, rotation.
	await frame('phone-home', async () => {
		await returnHomeFromBrowse(maya);
		await sleep(500);
		await shoot(maya, 'phone-home', 'home is the queue: now-playing hero, your place in words, the rotation');
	});

	await frame('phone-now-playing', async () => {
		await sleep(400);
		await shoot(maya, 'phone-now-playing', 'now playing — key control, guiding track, the range the song asks for');
	});

	await frame('phone-second-guest', () =>
		shoot(ada, 'phone-second-guest', "Ada's view — the same rotation, synced over the socket")
	);

	await frame('phone-profile', async () => {
		await ada.clickByLabel('Your profile');
		await sleep(500);
		await shoot(ada, 'phone-profile', 'the profile sheet: name, colour, and the way out');
	});

	// ── the TV, now that someone is singing ──────────────────────────────────
	if (playing) {
		/*
		 * Wait for the ball to land on a word BEFORE shooting anything here. Songs open with an
		 * instrumental intro — Mr. Brightside's first line arrives around 8s — so a frame taken the
		 * moment the lower third appears catches a reel parked on line one, which is exactly what a
		 * frozen-playback bug also looks like. Waiting for `.word.active` proves the words are moving.
		 */
		await frame('tv-lyrics-word', async () => {
			await tv.waitFor(`document.querySelector(${JSON.stringify(SEL.activeWord)}) !== null`, {
				timeout: 60_000
			});
			await shoot(tv, 'tv-lyrics-word', 'word-timed lyrics: the ball sits on the word being sung');
		});

		await frame('tv-playing', async () => {
			await sleep(1200);
			await shoot(tv, 'tv-playing', 'now singing — the lower third names who has the mic');
		});

		/*
		 * The key shift goes AFTER the lyrics frames, deliberately.
		 *
		 * Shifting re-routes the audio through the browser pitch shifter's AudioWorklet graph, and in
		 * headless Chromium that leaves the media element paused — so every lyrics frame taken after a
		 * shift shows a reel frozen on the song's first line while still looking otherwise correct. The
		 * ± control is genuinely worth a frame, so it is captured here and the variant sweep below
		 * re-kicks playback rather than trusting it survived.
		 */
		await frame('phone-key-shifted', async () => {
			await maya.clickByText('semitone'); // the first ± button
			await sleep(700);
			await shoot(maya, 'phone-key-shifted', 'the key shifted — the sounding key and range move with it');
		});
	}

	// ── settings, and the room variants it drives ────────────────────────────
	/*
	 * Reuse ADA's page rather than opening a new one. Every browser.newPage() is an isolated context
	 * with its own cookie jar, so a fresh page has no session and /settings redirects it straight to
	 * /join — which an earlier run captured and mislabelled as a settings screenshot.
	 *
	 * The page is three SCOPES now (You / Party / Server) and only one is rendered at a time, so a
	 * control on an unselected tab is not in the DOM at all. Every frame and every flip below therefore
	 * declares the scope that owns its control. This is the step that broke on the split: `sync-mode`
	 * and `lyrics-ball` used to be flippable back to back, and now they live on different tabs.
	 */
	await ada.goto(`${base}/settings`);
	await ada.waitFor(`location.pathname === '/settings'`);
	await sleep(700);

	await frame('settings-you', async () => {
		await scope(ada, 'you');
		await shoot(ada, 'settings-you', 'who you are — the name and colour that used to live in a sheet');
	});

	await frame('settings-server', async () => {
		await scope(ada, 'server');
		await shoot(ada, 'settings-server', 'the deployment scope: splitter, lyrics engine, joining');
	});

	await frame('settings-room', async () => {
		await scope(ada, 'party');
		await ada.evaluate(
			`document.querySelector(${JSON.stringify(SEL.setting('queue-order'))})?.scrollIntoView({ block: 'center' })`
		);
		await sleep(400);
		await shoot(ada, 'settings-room', 'this room: house rule, TV progress and stage look');
	});

	await frame('settings-lyrics', async () => {
		await scope(ada, 'party');
		await ada.evaluate(
			`document.querySelector(${JSON.stringify(SEL.setting('lyrics-highlight'))})?.scrollIntoView({ block: 'center' })`
		);
		await sleep(400);
		await shoot(ada, 'settings-lyrics', 'lyrics on the TV: marker, highlight, lead, size, font, case, rows');
	});

	await frame('settings-advanced', async () => {
		// The one disclosure left, and it is on the server scope — the upgrade chain is a fleet property.
		await scope(ada, 'server');
		await ada.clickByText('Advanced');
		await sleep(500);
		await shoot(ada, 'settings-advanced', 'the advanced disclosure open — the progressive upgrade chain');
	});

	/*
	 * The clamp notice, which is the one settings warning worth a frame.
	 *
	 * Server timing decides whether per-word timings EXIST; the room only decides how they are drawn.
	 * So asking for a word-level marker while the deployment is on line-sync is a request the room
	 * cannot honour — and rather than silently ignoring the picker, the page says which treatment it
	 * substituted and which setting to change to get the other one back. Without this frame that
	 * interaction is invisible until someone hits it and assumes their setting is broken.
	 *
	 * Two scopes, in order: the cause lives on Server, the effect is drawn on Party. That crossing is
	 * the whole point of the notice, and it is why this frame switches tabs mid-way.
	 */
	await frame('settings-lyrics-clamped', async () => {
		await scope(ada, 'server');
		await setSetting(ada, 'sync-mode', 'lines');
		await scope(ada, 'party');
		await setSetting(ada, 'lyrics-highlight', 'word');
		await setSetting(ada, 'lyrics-ball', 'bounce');
		await ada.evaluate(
			`document.querySelector(${JSON.stringify(SEL.setting('lyrics-ball'))})?.scrollIntoView({ block: 'center' })`
		);
		await sleep(500);
		await shoot(ada, 'settings-lyrics-clamped', 'a room asking for word timings a line-sync deployment cannot give');
		await scope(ada, 'server');
		await setSetting(ada, 'sync-mode', 'forced'); // put the deployment back
	});

	/*
	 * The misconfigured-QR screen, driven through the real setting rather than staged.
	 *
	 * Worth a frame because it is the single most common first-run failure — the TV advertises an
	 * address phones cannot reach (a loopback bind, a WSL2 NAT, a proxy that forwards no
	 * X-Forwarded-*) and the room looks broken with no clue why. The screen names the bad address and
	 * the setting that fixes it, and that is the thing people need to recognise.
	 */
	await frame('tv-join-unreachable', async () => {
		// The join address is a server-scope setting, so select that tab before reaching for the control.
		await scope(ada, 'server');
		// read the control's OWN value, not the TV's short display text, so the restore is exact
		const was = await ada.evaluate(
			`document.querySelector(${JSON.stringify(SEL.setting('join-origin'))})?.value ?? ''`
		);
		await ada.fill(SEL.setting('join-origin'), 'http://127.0.0.1:3500');
		await sleep(1200);
		await shoot(tv, 'tv-join-unreachable', 'the QR a phone cannot reach — named, with the fix');
		await ada.fill(SEL.setting('join-origin'), was);
		await sleep(900);
	});

	// Only meaningful while something is on screen to restyle.
	if (playing) {
		/*
		 * The variant sweep below is ~20 settings changes long. If the song ran out during the settings
		 * frames the room has moved to its next/waiting screen and every remaining frame would quietly
		 * capture the wrong surface, so nudge the media back into playing first and say so if it will
		 * not go.
		 */
		const still = await positionAdvancing(tv);
		if (!still) {
			const ok = await ensurePlaying(tv, maya);
			console.log(`    re-started for the variant sweep: ${ok ? 'advancing' : 'STILL STUCK'}`);
		}

		// ── lyrics variants ──────────────────────────────────────────────────
		for (const [val, note] of [
			['steady', 'a steady marker instead of a bounce'],
			['underline', 'the marker as an underline'],
			['off', 'no marker at all — highlight carries it']
		]) {
			await frame(`tv-lyrics-ball-${val}`, async () => {
				await setSetting(ada, 'lyrics-ball', val);
				await shoot(tv, `tv-lyrics-ball-${val}`, note);
			});
		}
		await setSetting(ada, 'lyrics-ball', 'bounce');

		for (const [val, note] of [
			['line', 'the whole line lights instead of the word — honest when timings are patchy'],
			['off', 'no highlight: plain text on the reel']
		]) {
			await frame(`tv-lyrics-highlight-${val}`, async () => {
				await setSetting(ada, 'lyrics-highlight', val);
				await shoot(tv, `tv-lyrics-highlight-${val}`, note);
			});
		}
		await setSetting(ada, 'lyrics-highlight', 'word');

		await frame('tv-lyrics-upper', async () => {
			await setSetting(ada, 'lyrics-case', 'upper');
			await shoot(tv, 'tv-lyrics-upper', 'the words set upper case');
		});
		await setSetting(ada, 'lyrics-case', 'natural');

		await frame('tv-lyrics-serif', async () => {
			await setSetting(ada, 'lyrics-font', 'serif');
			await shoot(tv, 'tv-lyrics-serif', 'a serif face for the reel');
		});
		await setSetting(ada, 'lyrics-font', 'system');

		// ── progress placements ──────────────────────────────────────────────
		for (const [val, note] of [
			['card', 'progress inside the now-singing card'],
			['corner', 'a thin bar and a time-remaining pill'],
			['edge', 'a full-width bar on the bottom edge, no numbers'],
			['off', 'no progress on the TV — the phone still has it']
		]) {
			await frame(`tv-progress-${val}`, async () => {
				await setSetting(ada, 'tv-progress', val);
				await shoot(tv, `tv-progress-${val}`, note);
			});
		}
		await setSetting(ada, 'tv-progress', 'card');

		// ── stage look ───────────────────────────────────────────────────────
		for (const [val, note] of [
			['off', 'black behind the song — what the TV has always done'],
			['gradient', "the room's own glow"],
			['singer', "the singer's colour"],
			['solid', 'one colour, picked and left alone']
		]) {
			await frame(`tv-bg-${val}`, async () => {
				await setSetting(ada, 'tv-background', val);
				await shoot(tv, `tv-bg-${val}`, note);
			});
		}

		// ── the visualizers ──────────────────────────────────────────────────
		await setSetting(ada, 'tv-background', 'visualizer');
		for (const [val, note] of [
			['plasma', 'plasma — time-driven, not signal-driven'],
			['starfield', 'starfield'],
			['moire', 'ripples: concentric rings interfering'],
			['lissajous', 'phase curves drawing and redrawing']
		]) {
			await frame(`tv-vis-${val}`, async () => {
				await setSetting(ada, 'tv-visualizer', val, 1200);
				await shoot(tv, `tv-vis-${val}`, note);
			});
		}
		await setSetting(ada, 'tv-background', 'off');
	}

	// ── cook something raw, for the cooking state and the job ledger ─────────
	/*
	 * Deliberately AFTER the playing frames. Cooking is what a fresh install actually does first, and
	 * it is also the only way `/metrics` and the per-song audit page have anything to show: those read
	 * the append-only job_attempts ledger, which only gets rows when a job is really assigned to a
	 * worker. No worker connected means both pages are structurally empty and their frames are skipped.
	 */
	await frame('phone-cooking', async () => {
		await maya.goto(`${base}/`);
		await openBrowseFromHome(maya);
		await maya.fill(SEL.search, 'believin');
		/*
		 * Wait for the COOK ACTION, not for `.row`. The library is already on screen when the search box
		 * is typed into, so `.row` matches instantly against rows that are not the search results yet —
		 * and the count of `.sing` a moment later is then 0 for timing reasons rather than because
		 * nothing is cookable. Waiting on the thing about to be clicked removes the race.
		 */
		await maya.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.sing)}).length > 0`, {
			timeout: 20_000
		});
		await sleep(300);
		await maya.click(SEL.sing);
		await sleep(2500);
		await shoot(maya, 'phone-cooking', 'the song is cooking and HOLDS its rotation slot');
	});

	// ── the dashboards ───────────────────────────────────────────────────────
	await frame('stats-public', async () => {
		await ada.goto(`${base}/stats`);
		await ada.waitFor(`document.querySelector(${JSON.stringify(SEL.pageHeading)}) !== null`);
		await sleep(900);
		await fitViewport(ada, 1280);
		await shoot(ada, 'stats-public', 'the public page: library size, most-sung, top artists, sings per day');
	});

	await frame('metrics-internal', async () => {
		await ada.goto(`${base}/metrics`);
		await ada.waitFor(`document.querySelector(${JSON.stringify(SEL.pageHeading)}) !== null`);
		await sleep(900);
		await fitViewport(ada, 1280);
		await shoot(ada, 'metrics-internal', 'the internal page: time per step, cost per model against its own claim');
	});

	await frame('metrics-per-song', async () => {
		const first = await ada.evaluate(`(document.querySelector('a[href^="/metrics/"]')?.getAttribute('href') ?? '')`);
		if (!first) throw new Error('no per-song audit link on /metrics (no cooks recorded yet)');
		await ada.goto(`${base}${first}`);
		await sleep(800);
		await fitViewport(ada, 1280);
		await shoot(ada, 'metrics-per-song', 'one song audited: every cook, every retry, which model, why it failed');
	});

	// ── the component gallery ────────────────────────────────────────────────
	await frame('gallery', async () => {
		const gallery = await browser0.newPage();
		await gallery.goto(`${base}/components`);
		await sleep(1400);
		await fitViewport(gallery, 1280);
		await shoot(gallery, 'gallery', 'every component in one place, including the TV pieces');
	});
} catch (err) {
	console.error('capture failed:', err);
	process.exitCode = 1;
} finally {
	browser?.close();
	proc.kill();
}

console.log(`\n${shots.length} frames written to ${OUT}`);
if (skipped.length) {
	console.log(`${skipped.length} skipped:`);
	for (const s of skipped) console.log(`  - ${s.name}: ${s.why}`);
}
