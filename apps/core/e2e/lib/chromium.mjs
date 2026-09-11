/*
 * CANONICAL Chromium discovery for every e2e driver.
 *
 * `findChromium()` was copy-pasted into 15 drivers under apps/core/e2e and drifted three ways
 *: only two copies validated PW_CHROMIUM, one hardcoded a personal
 * home path, and the 4-line variants dropped the /usr/bin fallback. This is the single source of
 * truth so that drift is inexpressible — a source-scan guard in bun test (see lib/chromium.test.ts)
 * asserts no other .mjs under e2e/ redefines it.
 *
 * VALIDATED, not trusted: an unset-but-wrong PW_CHROMIUM used to sail past the trusting copies and
 * surface as a CDP connect failure, which reads like a driver bug instead of a missing browser. When
 * PW_CHROMIUM is set to a path that does not exist we return null (the caller bails loudly) rather
 * than handing a bogus path to spawn.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Locate a usable Chromium binary, or return null if none is found.
 * @returns {string | null}
 */
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
