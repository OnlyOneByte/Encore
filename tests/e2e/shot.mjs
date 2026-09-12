// Eyes-on screenshot helper. Drives the Chromium already cached for the e2e probes
// (~/.cache/ms-playwright/chromium-<build>/chrome-linux/chrome) through the repo's own
// e2e driver.
//
// WHY IT GOES THROUGH THE SHARED DRIVER. This file used to `import { chromium } from
// 'playwright-core'`, which was never a declared dependency — it worked on whichever machine
// happened to have one lying around and failed everywhere else. It now uses ./driver.mjs, the same
// connection every probe uses, so there is one place that decides how a browser is launched and
// which Chromium it points at.
//
// Usage: PW_CHROMIUM=/path/to/chrome bun run tests/e2e/shot.mjs <url> <outPath> [widthxheight]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { connect, sleep } from './driver.mjs';

const [, , url, out, size = '390x844'] = process.argv;
if (!url || !out) {
	console.error('usage: bun run tests/e2e/shot.mjs <url> <outPath> [widthxheight]');
	process.exit(2);
}
const [w, h] = size.split('x').map(Number);

// Resolve the browser: an explicit override wins, otherwise the same cached builds the e2e probes use.
const chrome = [
	process.env.PW_CHROMIUM,
	pathJoin(homedir(), '.cache/ms-playwright/chromium-1232/chrome-linux/chrome'),
	pathJoin(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux/chrome')
].find((p) => p && existsSync(p));
if (!chrome) {
	console.error('no chromium — set PW_CHROMIUM or install the cached ms-playwright build');
	process.exit(2);
}

const cdpPort = 9200 + (process.pid % 1000);
const proc = spawn(
	chrome,
	[
		`--remote-debugging-port=${cdpPort}`,
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		'--no-first-run',
		`--user-data-dir=${process.env.KIROCREW_SCRATCH ?? '/tmp'}/shot-${cdpPort}`,
		'about:blank'
	],
	{ stdio: 'ignore' }
);

let browser;
try {
	await sleep(300);
	browser = await connect(cdpPort);
	const page = await browser.newPage();
	await page.viewport(w, h, 2);
	await page.goto(url);
	await page.screenshot(out);
	console.log('shot ->', out);
} finally {
	browser?.close();
	proc.kill();
}
