// Finding a Chromium, with the failure modes this box actually has.
//
// Playwright resolves its own download by version, so a cache holding build 1223 while the installed
// @playwright/test wants 1194 fails with "Executable doesn't exist" and a suggestion to reinstall — even
// though a perfectly good Chromium is sitting right there. This falls back to whatever IS in the cache
// rather than making every spec fail on a version digit.
//
// It replaces tests/e2e/lib/chromium.mjs, which only ever looked for Linux paths (`chrome-linux/chrome`) and
// two pinned build numbers, so on a Mac it found nothing unless PW_CHROMIUM was already set.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Where a build's executable lives, per platform, relative to the build directory. */
const RELATIVE_BINARIES = [
	// macOS, both namings Playwright has shipped
	'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
	'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
	'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
	'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
	// Linux: the old shared dir, then the per-arch dirs newer builds ship (a `chromium_headless_shell-N` build
	// holds only the `chrome-headless-shell-*` one)
	'chrome-linux/chrome',
	'chrome-linux/headless_shell',
	'chrome-linux64/chrome',
	'chrome-linux-arm64/chrome',
	'chrome-headless-shell-linux64/chrome-headless-shell',
	'chrome-headless-shell-linux-arm64/chrome-headless-shell',
	// Windows
	'chrome-win/chrome.exe'
];

const CACHES = [
	join(homedir(), 'Library', 'Caches', 'ms-playwright'), // macOS
	join(homedir(), '.cache', 'ms-playwright') // Linux
];

/** The Chromium build number the installed playwright-core expects, or undefined if it can't be read. */
function pinnedRevision(): number | undefined {
	try {
		const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
		const { browsers } = JSON.parse(readFileSync(join(dirname(pkg), 'browsers.json'), 'utf8'));
		return Number(browsers.find((b: { name: string }) => b.name === 'chromium')?.revision) || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Override with PW_CHROMIUM=/path/to/chrome when the cache holds no build that launches on this host.
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

	const pinned = pinnedRevision();
	const rank = (d: string) => {
		const rev = Number(d.split('-')[1]);
		return (rev === pinned ? 1e9 : 0) + rev;
	};
	for (const cache of CACHES) {
		if (!existsSync(cache)) continue;
		// The build the installed @playwright/test was made against first: a newer one can need host libraries
		// the pinned one does not. Then highest build number; full Chromium before headless shell on a tie.
		const builds = readdirSync(cache)
			.filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
			.sort((a, b) => rank(b) - rank(a) || (a < b ? -1 : 1)); // code-unit order: `chromium-` < `chromium_`
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
