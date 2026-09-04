/*
 * Capture every UI surface, driven into each state rather than photographed as it happens to load.
 *
 *   bun run e2e:seed
 *   ENCORE_EPHEMERAL=1 PORT=3500 MEDIA_DIR=<seeded> bun run start
 *   EPORT=3500 bun run e2e/capture.mjs [outDir]
 *
 * This exists because a screenshot of a default page proves almost nothing: the states worth looking at
 * are the ones a guest actually hits — a queue with a song cooking in it, the sheet pulled up, the TV
 * once someone has joined. Each frame below is reached by driving the real app through the real
 * controls, so what you see is what a guest would see.
 *
 * The TV is captured at 1920x1080 because its type scale is vh-relative: a frame taken at the wrong
 * height is measuring a different design.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';
import { SEL, PRESET_COLOUR_NAMES } from './contract.ts';

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;
const OUT = process.argv[2] ?? join(import.meta.dir, '..', '..', '..', 'docs', 'shots');
const CDP_PORT = Number(process.env.CDP_PORT ?? 9500);

const PHONE = [430, 860];
const TV = [1920, 1080];

function findChromium() {
	if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
	for (const b of ['chromium-1232', 'chromium-1228']) {
		const p = join(homedir(), '.cache', 'ms-playwright', b, 'chrome-linux', 'chrome');
		if (existsSync(p)) return p;
	}
	for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
		if (existsSync(p)) return p;
	}
	return null;
}

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
const shots = [];
const proc = spawn(
	chromium,
	[
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		'--hide-scrollbars',
		`--remote-debugging-port=${CDP_PORT}`,
		'--remote-allow-origins=*',
		'about:blank'
	],
	{ stdio: 'ignore' }
);

async function shoot(page, name, note) {
	const path = join(OUT, `${name}.png`);
	await page.screenshot(path);
	shots.push({ name, note, path });
	console.log(`  ${name}.png — ${note}`);
}

let browser;
try {
	browser = await connect(CDP_PORT);

	// ── TV first: attract only exists while the room is empty ────────────────
	const tv = await browser.newPage();
	await tv.viewport(...TV, 1);
	await tv.goto(`${base}/tv`);
	await tv.waitFor(`document.querySelector('.url') !== null`);
	await shoot(tv, 'tv-1-attract', 'nobody here yet — the QR owns the screen');

	// ── join, both ways of picking a colour ──────────────────────────────────
	const maya = await browser.newPage();
	await maya.viewport(...PHONE);
	await maya.goto(`${base}/join`);
	await shoot(maya, 'join-1-default', 'presets, with the violet default selected');

	await maya.setRange(SEL.hueSlider, 150);
	await sleep(300);
	await shoot(maya, 'join-2-hue-wheel', 'a hue picked off the wheel — lightness and chroma stay pinned');

	await maya.fill(SEL.nameInput, 'Maya');
	await maya.clickByLabel(SEL.swatch(PRESET_COLOUR_NAMES[1]).name); // pink
	await sleep(250);
	await shoot(maya, 'join-3-ready', 'name entered and a preset chosen, submit enabled');
	await maya.clickByText('Start singing');
	await maya.waitFor(`location.pathname === '/'`);
	await maya.waitFor(`document.querySelector(${JSON.stringify(SEL.search)}) !== null`);

	// ── phone remote ─────────────────────────────────────────────────────────
	await sleep(600);
	await shoot(maya, 'phone-1-empty', 'first run: nothing cooked yet, so the library is empty');

	await maya.fill(SEL.search, 'caroline');
	await maya.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length`, { timeout: 15_000 });
	await sleep(400);
	await shoot(maya, 'phone-2-search', 'unified search — one row shape, one action per row');

	// queue whichever action is offered; a fresh install has only raw results
	const action = (await maya.count(SEL.addTurn)) > 0 ? SEL.addTurn : SEL.sing;
	await maya.click(action);
	await maya
		.waitFor(`document.querySelectorAll('.qrow').length + document.querySelectorAll('.proc').length`, {
			timeout: 10_000
		})
		.catch(() => 0);
	await sleep(900);
	await shoot(maya, 'phone-3-cooking', 'the song is cooking and HOLDS its rotation slot');

	// The peek is a div with role=button driven by pointer + keydown handlers, not onclick, so a click
	// does nothing at all. ArrowUp is its documented open gesture.
	await maya.pressKey('.peek', 'ArrowUp');
	await maya.waitFor(`document.querySelector('.sheet')?.classList.contains('open') === true`, {
		timeout: 5000
	});
	await sleep(600);
	await shoot(maya, 'phone-4-queue-sheet', 'the pull-up sheet: rotation plus the transport');

	// second guest, so the roster and cross-client sync are visible
	const ada = await browser.newPage();
	await ada.viewport(...PHONE);
	await ada.goto(`${base}/join`);
	await ada.fill(SEL.nameInput, 'Ada');
	await ada.setRange(SEL.hueSlider, 210);
	await ada.clickByText('Start singing');
	await ada.waitFor(`location.pathname === '/'`);
	await sleep(900);
	await shoot(ada, 'phone-5-second-guest', "Ada's view — the same rotation, synced over the socket");

	// ── settings ─────────────────────────────────────────────────────────────
	/*
	 * Reuse ADA's page rather than opening a new one. Every browser.newPage() is an isolated context with
	 * its own cookie jar, so a fresh page has no session and /settings redirects it straight to /join —
	 * which is what the first run captured and mislabelled as a settings screenshot.
	 */
	await ada.goto(`${base}/settings`);
	await ada.waitFor(`location.pathname === '/settings'`);
	await sleep(600);
	await shoot(ada, 'settings-1', 'global vs room scope, stated rather than implied');
	await ada.clickByText('Advanced');
	await sleep(400);
	await shoot(ada, 'settings-2-advanced', 'the advanced disclosure open');

	// ── TV again, now that the room has people and a queue ───────────────────
	await tv.goto(`${base}/tv`);
	await sleep(1500);
	await shoot(tv, 'tv-2-lobby', 'people are here — the roster names them');

	// ── the component gallery ────────────────────────────────────────────────
	const gallery = await browser.newPage();
	await gallery.viewport(1280, 1400, 1);
	await gallery.goto(`${base}/components`);
	await sleep(1200);
	await shoot(gallery, 'gallery', 'every component in one place, including the TV pieces');
} catch (err) {
	console.error('capture failed:', err);
	process.exitCode = 1;
} finally {
	browser?.close();
	proc.kill();
}

console.log(`\n${shots.length} frames written to ${OUT}`);
