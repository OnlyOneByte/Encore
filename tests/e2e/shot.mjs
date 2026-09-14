// Eyes-on screenshot helper. Drives the Chromium already cached for the e2e probes through the
// repo's own e2e driver.
//
// WHY IT GOES THROUGH THE SHARED DRIVER. This file used to `import { chromium } from
// 'playwright-core'`, which was never a declared dependency — it worked on whichever machine
// happened to have one lying around and failed everywhere else. It now uses ./driver.mjs, the same
// connection every probe uses, so there is one place that decides how a browser is launched and
// which Chromium it points at.
//
// It also used to spawn its OWN Chromium with `--remote-debugging-port` and then call
// `connect(cdpPort)`. The driver launches its own browser and ignored that port, so the spawned
// process was never connected to by anything — a whole wasted Chromium per invocation. The
// Chromium-spawn sweep missed it because this file lived under `scripts/` at the time, outside the
// tree that sweep walked. Both the spawn and the port are gone; browser discovery is the driver's
// job, via `findChromium`.
//
// Usage: PW_CHROMIUM=/path/to/chrome bun run tests/e2e/shot.mjs <url> <outPath> [widthxheight]
import { connect } from './driver.mjs';

const [, , url, out, size = '390x844'] = process.argv;
if (!url || !out) {
	console.error('usage: bun run tests/e2e/shot.mjs <url> <outPath> [widthxheight]');
	process.exit(2);
}
const [w, h] = size.split('x').map(Number);

let browser;
try {
	browser = await connect();
	const page = await browser.newPage();
	await page.viewport(w, h, 2);
	await page.goto(url);
	await page.screenshot(out);
	console.log('shot ->', out);
} finally {
	await browser?.close();
}
