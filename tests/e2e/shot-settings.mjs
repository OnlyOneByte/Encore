// Settings-only capture: three tabs and a joined session, where capture.mjs walks ~30 frames and needs a
// seeded library. `scope()` clicks the trigger and waits for aria-selected rather than sleeping, so a frame
// here is reached the way the real capture reaches it.
//
// Usage: EPORT=3411 OUT=/abs/dir TAG=before bun run tests/e2e/shot-settings.mjs
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from './driver.mjs';
import { SEL } from './contract.ts';
import { openJoin } from './lib/join.mjs';

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;
const OUT = process.env.OUT ?? '/tmp/settings-shots';
const TAG = process.env.TAG ?? 'shot';

// DPR 1 on purpose: these frames are read back by an agent, and this environment hard-fails on any
// image over 2000px on either axis. 430x1500 at DPR 1 stays inside that on the longest tab.
const W = 430;
const H = 1500;

if (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
	console.error(`No Encore server on ${base}.`);
	process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const browser = await connect();
try {
	const page = await browser.newPage();
	await page.viewport(W, H, 1);

	// Join first. /settings is join-gated, so a page that goes straight there lands on /join.
	// A unique name because a duplicate display name 409s and the room persists across runs.
	await openJoin(page, base);
	await page.fill(SEL.nameInput, `Copy${Date.now() % 100000}`);
	await sleep(250);
	await page.clickByRole('button', 'Start singing');
	await page.waitFor(`location.pathname === '/'`);
	// Let the client router settle before navigating again: a goto issued while the post-join
	// navigation is still in flight is superseded and comes back ERR_ABORTED.
	await sleep(2000);

	await page.goto(`${base}/settings`);
	await page.waitFor(`location.pathname === '/settings'`);
	await sleep(600);

	const scope = async (/** @type {string} */ id) => {
		await page.click(SEL.settingsTab(id));
		await page.waitFor(
			`document.querySelector(${JSON.stringify(SEL.settingsTab(id))})?.getAttribute('aria-selected') === 'true'`
		);
		await sleep(350);
	};

	const shoot = async (/** @type {string} */ name) => {
		const path = join(OUT, `${TAG}-${name}.png`);
		await page.screenshot(path);
		console.log('  ✓', path);
	};

	await scope('you');
	await shoot('you');

	await scope('party');
	await page.evaluate(`window.scrollTo(0, 0)`);
	await sleep(250);
	await shoot('party-top');
	await page.evaluate(
		`document.querySelector(${JSON.stringify(SEL.setting('lyrics-highlight'))})?.scrollIntoView({ block: 'start' })`
	);
	await sleep(350);
	await shoot('party-lyrics');

	await scope('server');
	await page.evaluate(`window.scrollTo(0, 0)`);
	await sleep(250);
	await shoot('server');
} finally {
	await browser.close();
}
