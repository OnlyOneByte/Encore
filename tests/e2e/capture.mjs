// Capture every UI surface, driven into each state rather than photographed as it happens to load.
//
//   ENCORE_EPHEMERAL=1 PORT=3500 MEDIA_DIR=<media> bun run start EPORT=3500 bun run tests/e2e/capture.mjs [outDir]
//
// TWO PRECONDITIONS, both silent when lost. Autoplay is GRANTED below, which makes this a NOT-A-TV run by
// construction (docs/E2E.md#autoplay); without it every playing-state frame degrades to the lobby with no
// error. And the playing frames need REAL processed songs — `e2e:seed` writes undecodable placeholders, so
// point MEDIA_DIR at a processed library or expect those frames to be skipped, loudly.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from './driver.mjs';
import { SEL } from './contract.ts';
import { findChromium } from './lib/chromium.mjs';
import { openBrowseFromHome, returnHomeFromBrowse } from './lib/phone.mjs';
import { atRepo as at } from './lib/repo-root.mjs';
import { openJoin } from './lib/join.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 */

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;
const OUT = process.argv[2] ?? at('docs/mocks');
/** The id half of `<id>-<what>-eyeson.png`. */
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

/** @param {Page} page @param {string} name @param {string} note */
async function shoot(page, name, note) {
	const path = join(OUT, `${ID}-${name}-eyeson.png`);
	await page.screenshot(path);
	shots.push({ name, note });
	console.log(`  ✓ ${name} — ${note}`);
}

// One frame must not cost the other forty: a run is a long chain of stateful steps and the failure that
// happens is one control moving, which would otherwise leave the set half-regenerated and silently mixed
// between old and new. Each frame is attempted independently; failures are named at the end.
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

// Driven through the real tab, not `?tab=`, so the control gating every setting is exercised too. The wait
// is on `aria-selected`, which flips only once the panel has swapped: a fixed sleep shoots the OUTGOING tab.
/** @param {Page} page @param {string} id */
async function scope(page, id) {
	await page.click(SEL.settingsTab(id));
	await page.waitFor(
		`document.querySelector(${JSON.stringify(SEL.settingsTab(id))})?.getAttribute('aria-selected') === 'true'`
	);
	await sleep(350);
}

// Size the viewport to the page's own content: a fixed tall viewport turns a 660px page into a frame two
// thirds black, which reads as a rendering bug rather than a small library. Capped at 2000px, past which
// the tooling that reviews these frames cannot read them back.
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

// Start the TV's media element by hand — NOT a shortcut around the app: the phone has already sent the real
// play command and the room is in its playing state. Headless Chromium refuses to start an UNMUTED element
// without a gesture, so the autoplay flag is necessary and not sufficient. Skipping this leaves every frame
// looking plausible; the only tell is the reel frozen on line one.
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
		// The master is an <audio> — an instrumental has no picture. A bare 'video' reads -1 forever here.
		tv.evaluate(
			`(() => { const v = document.querySelector(${JSON.stringify(SEL.mediaEl)}); return v ? v.currentTime : -1; })()`
		);
	const a = await read();
	await sleep(overMs);
	const b = await read();
	return b > a + 0.2;
}

// Get the room genuinely singing, and PROVE it. The room starts the song ITSELF once one is queued with a TV
// attached, so a single play/pause tap lands on an already-playing room and PAUSES it. Toggle, kick the
// element past the headless autoplay block, and accept it only once the position has moved.
/** @param {Page} tv @param {Page} phone @param {{ attempts?: number }} [opts] @returns {Promise<boolean>} */
async function ensurePlaying(tv, phone, { attempts = 3 } = {}) {
	for (let i = 0; i < attempts; i++) {
		await kickPlayback(tv);
		if (await positionAdvancing(tv)) return true;
		await phone.click(SEL.bandTransport);
		await sleep(600);
		await kickPlayback(tv);
		if (await positionAdvancing(tv)) return true;
	}
	return false;
}

/** @type {Browser | undefined} */
let browser;
try {
	// The autoplay grant, without which every captured frame is the poster. The driver never grants it.
	const browser0 = await connect({ args: ['--autoplay-policy=no-user-gesture-required'] });
	browser = browser0;

	// TV first: attract only exists while the room is empty.
	const tv = await browser0.newPage();
	await tv.viewport(...TV, 1);
	await tv.goto(`${base}/tv`);
	// Wait on the QR's ALT TEXT: it is a HOOK, so `bun test` reports a move before this run reaches step one.
	await tv.waitForSelector(SEL.qrImage);
	await frame('tv-attract', () => shoot(tv, 'tv-attract', 'nobody here yet — the QR owns the screen'));

	// Join, and pick a colour off the ring.
	const maya = await browser0.newPage();
	await maya.viewport(...PHONE);
	await openJoin(maya, base);

	// `End` walks the ring to its last stop — a real interaction, and visibly not the default.
	await frame('join-colour-ring', async () => {
		await maya.pressKey(SEL.colourRing, 'End');
		await sleep(300);
		await shoot(
			maya,
			'join-colour-ring',
			'the full hue circle — lightness and chroma stay pinned, the hub names the stop'
		);
	});

	await maya.fill(SEL.nameInput, 'Maya');
	await maya.pressKey(SEL.colourRing, 'Home');
	await sleep(250);
	await frame('join-ready', () => shoot(maya, 'join-ready', 'name entered and a ring stop chosen, submit enabled'));
	await maya.clickByRole('button', 'Start singing');
	await maya.waitFor(`location.pathname === '/'`);
	await openBrowseFromHome(maya);
	await sleep(700);

	// Phone remote: the library, then search. The TV is in its LOBBY state at this exact point and nowhere
	// else in the run — someone is in the room, nothing is queued — so the frame has to be taken here.
	await frame('tv-lobby', async () => {
		await sleep(900);
		await shoot(tv, 'tv-lobby', 'someone is here but nothing is queued — the room asks for a pick');
	});

	await frame('phone-library', () =>
		shoot(maya, 'phone-library', 'the library as it opens — processed songs, newest first')
	);

	// Only visible with a query in the box.
	await frame('phone-browse', async () => {
		await openBrowseFromHome(maya); // a no-op when the field is already there; keeps the fill safe
		await maya.fill(SEL.search, 'a');
		await sleep(700);
		await shoot(maya, 'phone-browse', 'search docked in the thumb zone, results stacking upward from it');
		await openBrowseFromHome(maya);
		await maya.fill(SEL.search, ''); // clear it again so it does not shadow later frames
		await sleep(400);
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
		await openBrowseFromHome(maya); // search lives behind the browse push
		await maya.fill(SEL.search, readyQuery ?? 'caroline');
		await maya.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length`, {
			timeout: 15_000
		});
		await sleep(500);
		await shoot(maya, 'phone-search', 'unified search — one row shape, one action per row, readiness first');
	});

	// A second guest, so the roster and cross-client sync are visible.
	const ada = await browser0.newPage();
	await ada.viewport(...PHONE);
	await openJoin(ada, base);
	await ada.fill(SEL.nameInput, 'Ada');
	// A stop away from Maya's, by key.
	await ada.pressKey(SEL.colourRing, 'End');
	await ada.clickByRole('button', 'Start singing');
	await ada.waitFor(`location.pathname === '/'`);
	await sleep(800);

	// Queue it, and start singing.
	let playing = false;
	if (readyQuery) {
		await frame('queue+play', async () => {
			await maya.click(SEL.addTurn);
			await maya
				.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`, { timeout: 10_000 })
				.catch(() => 0);
			await sleep(600);
			// The transport is in the band row, on every phone surface.
			await returnHomeFromBrowse(maya);
			await sleep(400);
			await maya.click(SEL.bandTransport);
			// The song-intro card lives in the gap between "the player is ready" and "the song is playing",
			// so it must be caught HERE — the position check below cannot pass while the room is still
			// holding on the intro. Time-boxed to the room's songIntroMs (2.5s default, `0` disables it), so
			// a miss is best-effort by design: one frame, reported, never the run.
			await frame('tv-song-intro', async () => {
				await tv.waitForSelector(SEL.stateNext, {
					timeout: 20_000
				});
				await shoot(tv, 'tv-song-intro', 'the song-intro card names who is up before the music starts');
			});
			// the TV naming a singer means a song is CURRENT — not that it is moving
			await tv.waitForSelector(SEL.lowerThird, {
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

	// The TV, now that someone is singing.
	if (playing) {
		// Wait for the ball to land on a word BEFORE shooting: songs open with an instrumental intro, so a
		// frame taken as the lower third appears catches a reel on line one — a frozen-playback bug's twin.
		await frame('tv-lyrics-word', async () => {
			await tv.waitForSelector(SEL.activeWord, {
				timeout: 60_000
			});
			await shoot(tv, 'tv-lyrics-word', 'word-timed lyrics: the ball sits on the word being sung');
		});

		await frame('tv-playing', async () => {
			await sleep(1200);
			await shoot(tv, 'tv-playing', 'now singing — the lower third names who has the mic');
		});

		// AFTER the lyrics frames: shifting re-routes audio through the pitch shifter's AudioWorklet graph,
		// which in headless Chromium leaves the element PAUSED, so any later lyrics frame shows a frozen reel
		// while looking otherwise correct. The sweep below re-kicks playback rather than trusting it.
		await frame('phone-key-shifted', async () => {
			await maya.clickByText('semitone'); // the first ± button
			await sleep(700);
			await shoot(maya, 'phone-key-shifted', 'the key shifted — the sounding key and range move with it');
		});
	}

	// Settings. REUSE ADA'S PAGE: every newPage() has its own cookie jar, so a fresh page has no session and
	// /settings redirects it to the join screen. And only ONE of the three scopes is in the DOM at a time, so
	// every frame and flip below declares the scope that owns its control.
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
		// The one disclosure left, on the server scope: the upgrade chain is a fleet property.
		await scope(ada, 'server');
		await ada.clickByText('Advanced');
		await sleep(500);
		await shoot(ada, 'settings-advanced', 'the advanced disclosure open — the progressive upgrade chain');
	});

	// The clamp notice. Server timing decides whether per-word timings EXIST; the room only decides how they
	// are drawn. TWO SCOPES, in order — the cause is on Server, the effect on Party, hence the tab switch.
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

	// The misconfigured-QR screen, driven through the real setting rather than staged: it is the commonest
	// first-run failure (a loopback bind, a WSL2 NAT, a proxy forwarding no X-Forwarded-*).
	await frame('tv-join-unreachable', async () => {
		// A server-scope setting, so select that tab before reaching for the control.
		await scope(ada, 'server');
		// Read the control's OWN value, not the TV's short display text, so the restore is exact.
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
		// The sweep below is ~20 settings changes long, so if the song ran out during the settings frames
		// every remaining frame captures the wrong surface. Nudge playback back first, and say so if it will not go.
		const still = await positionAdvancing(tv);
		if (!still) {
			const ok = await ensurePlaying(tv, maya);
			console.log(`    re-started for the variant sweep: ${ok ? 'advancing' : 'STILL STUCK'}`);
		}

		// Lyrics variants.
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

		// Progress placements.
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

		// Stage look.
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

		// The visualizers.
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

	// Process something raw, deliberately AFTER the playing frames. It is also the only way `/metrics` and the
	// per-song audit have anything to show: they read the append-only job_attempts ledger, which gets rows only
	// when a job is really assigned, so with no worker connected both pages are empty and skipped.
	await frame('phone-processing', async () => {
		await maya.goto(`${base}/`);
		await openBrowseFromHome(maya);
		await maya.fill(SEL.search, 'believin');
		// Wait for the PROCESS ACTION, not for a row: the library is already on screen when the box is typed
		// into, so a row matches instantly against results that have not arrived, and the count a moment
		// later reads 0 for timing reasons rather than for want of a processable.
		await maya.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.sing)}).length > 0`, {
			timeout: 20_000
		});
		await sleep(300);
		await maya.click(SEL.sing);
		await sleep(2500);
		await shoot(maya, 'phone-processing', 'the song is processing and HOLDS its rotation slot');
	});

	// The dashboards.
	await frame('stats-public', async () => {
		await ada.goto(`${base}/stats`);
		await ada.waitForSelector(SEL.pageHeading);
		await sleep(900);
		await fitViewport(ada, 1280);
		await shoot(ada, 'stats-public', 'the public page: library size, most-sung, top artists, sings per day');
	});

	await frame('metrics-internal', async () => {
		await ada.goto(`${base}/metrics`);
		await ada.waitForSelector(SEL.pageHeading);
		await sleep(900);
		await fitViewport(ada, 1280);
		await shoot(ada, 'metrics-internal', 'the internal page: time per step, cost per model against its own claim');
	});

	await frame('metrics-per-song', async () => {
		const first = await ada.evaluate(`(document.querySelector('a[href^="/metrics/"]')?.getAttribute('href') ?? '')`);
		if (!first) throw new Error('no per-song audit link on /metrics (no processes recorded yet)');
		await ada.goto(`${base}${first}`);
		await sleep(800);
		await fitViewport(ada, 1280);
		await shoot(ada, 'metrics-per-song', 'one song audited: every process, every retry, which model, why it failed');
	});

	// The component gallery.
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
}

console.log(`\n${shots.length} frames written to ${OUT}`);
if (skipped.length) {
	console.log(`${skipped.length} skipped:`);
	for (const s of skipped) console.log(`  - ${s.name}: ${s.why}`);
}
