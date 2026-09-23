/*
 * CANONICAL Chromium discovery for every e2e driver — `tests/guards/hygiene/chromium.test.ts` asserts no
 * other .mjs under tests/e2e redefines it, because the copies drifted (only some validated PW_CHROMIUM,
 * one hardcoded a home path, the short variants dropped the /usr/bin fallback).
 *
 * PW_CHROMIUM is VALIDATED, not trusted: a set-but-wrong path returns null so the caller bails loudly,
 * instead of handing a bogus path to spawn and surfacing as a launch failure that reads like a driver bug.
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
