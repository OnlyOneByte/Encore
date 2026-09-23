// Eyes-on screenshot helper, through the shared driver so browser discovery stays in one place.
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
