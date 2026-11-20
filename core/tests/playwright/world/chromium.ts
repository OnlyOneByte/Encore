// Finding a Chromium, with the failure modes this box actually has.
//
// Playwright resolves its own download by version, so a cache holding build 1223 while the installed
// @playwright/test wants 1194 fails with "Executable doesn't exist" and a suggestion to reinstall — even
// though a perfectly good Chromium is sitting right there. This falls back to whatever IS in the cache
// rather than making every spec fail on a version digit.
//
// It replaces tests/e2e/lib/chromium.mjs, which only ever looked for Linux paths (`chrome-linux/chrome`) and
// two pinned build numbers, so on a Mac it found nothing unless PW_CHROMIUM was already set.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where a build's executable lives, per platform, relative to the build directory. */
const RELATIVE_BINARIES = [
	// macOS, both namings Playwright has shipped
	'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
	'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
	'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
	'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
	// Linux
	'chrome-linux/chrome',
	'chrome-linux/headless_shell',
	// Windows
	'chrome-win/chrome.exe'
];

const CACHES = [
	join(homedir(), 'Library', 'Caches', 'ms-playwright'), // macOS
	join(homedir(), '.cache', 'ms-playwright') // Linux
];

/**
 * An explicit PW_CHROMIUM is VALIDATED, not trusted: a set-but-wrong path throws here with the path in the
 * message, rather than surfacing later as an opaque launch failure.
 *
 * Returns `undefined` when nothing is cached, which lets Playwright try its own resolution and print its own
 * `npx playwright install` remedy — the correct fix, and not something this should paper over silently.
 */
export function resolveChromium(): string | undefined {
	const declared = process.env.PW_CHROMIUM?.trim();
	if (declared) {
		if (!existsSync(declared)) {
			throw new Error(
				`PW_CHROMIUM is set to ${declared}, which does not exist. Unset it, or point it at a real binary.`
			);
		}
		return declared;
	}

	for (const cache of CACHES) {
		if (!existsSync(cache)) continue;
		// Highest build number first: the newest cached Chromium is the likeliest to match the app's needs.
		const builds = readdirSync(cache)
			.filter((d) => /^chromium-\d+$/.test(d))
			.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
		for (const build of builds) {
			for (const rel of RELATIVE_BINARIES) {
				const candidate = join(cache, build, rel);
				if (existsSync(candidate)) return candidate;
			}
		}
	}
	return undefined;
}

/** The config's own launch args. */
export const BASE_LAUNCH_ARGS = ['--no-sandbox', '--disable-gpu'];
