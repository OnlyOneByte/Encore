// Eyes-on screenshot helper. Uses the cached Playwright chromium (chromium-1223).
// Usage: node scripts/shot.mjs <url> <outPath> [widthxheight]
import { chromium } from 'playwright-core';

const [, , url, out, size = '390x844'] = process.argv;
const [w, h] = size.split('x').map(Number);

const exe = process.env.PW_CHROMIUM ?? '';
const browser = await chromium.launch({
	executablePath: exe || undefined,
	headless: true,
	args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.screenshot({ path: out });
await browser.close();
console.log('shot ->', out);
