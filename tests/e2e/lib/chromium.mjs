/*
 * CANONICAL Chromium discovery for every e2e driver — `tests/guards/hygiene/chromium.test.ts` reds if any
 * other .mjs under tests/e2e redefines it. PW_CHROMIUM is VALIDATED, not trusted: a set-but-wrong path
 * returns null so the caller bails loudly rather than surfacing as a launch failure.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** @returns {string | null} a usable Chromium binary, or null */
export function findChromium() {
	if (process.env.PW_CHROMIUM) return existsSync(process.env.PW_CHROMIUM) ? process.env.PW_CHROMIUM : null;
	const cache = join(homedir(), '.cache', 'ms-playwright');
	for (const b of ['chromium-1232', 'chromium-1228']) {
		const p = join(cache, b, 'chrome-linux', 'chrome');
		if (existsSync(p)) return p;
	}
	for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
		if (existsSync(p)) return p;
	}
	return null;
}
