// Playwright config for the `playwright/` suite, which replaces the hand-rolled tests/e2e tree.
//
// FOUR PROJECTS, because the old tree had four KINDS of artifact all implemented as the same thing — a .mjs
// script with process.exit(2) conventions:
//   gate   must fail a build. `bun run gate:measured` is leg 8 of `bun run gates`.
//   flow   long multi-client scenarios: a whole party, playback, the lobby, the fuzzer.
//   probe  one subject each, run when somebody wants the answer.
//   shot   produces artifacts. CANNOT fail a build, so it is excluded from every gate.
import { defineConfig, devices } from '@playwright/test';
import { resolveChromium, BASE_LAUNCH_ARGS } from './tests/playwright/world/chromium';

export default defineConfig({
	testDir: './tests/playwright/specs',
	// A spec boots its own core (migrations + boot passes + an ffmpeg probe per library file), so the ceiling
	// is per-test-generous rather than per-action-generous.
	timeout: 120_000,
	expect: { timeout: 15_000 },
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	// Each worker holds a core, a Chromium and up to four pages. Four is the ceiling this box absorbs without
	// the ffmpeg probes contending.
	workers: process.env.CI ? 2 : 4,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
	outputDir: './tests/playwright/.artifacts',

	use: {
		...devices['Desktop Chrome'],
		// Launched, never attached. PW_CHROMIUM wins; otherwise the newest cached build is used, because
		// Playwright resolves by exact version and fails on a digit mismatch even with a usable Chromium
		// present. `undefined` hands resolution back to Playwright and its own install remedy.
		// A per-file override must repeat `executablePath: resolveChromium()` and spread `BASE_LAUNCH_ARGS`:
		// Playwright REPLACES this object rather than merging it, so a spec setting its own loses
		// `executablePath` and fails as if the browser were not installed.
		launchOptions: { executablePath: resolveChromium(), args: BASE_LAUNCH_ARGS },
		// NO --autoplay-policy. A television grants no gesture, so proving playback with the policy relaxed
		// proves it in an environment the product never ships into. See docs/E2E.md#autoplay.
		trace: 'retain-on-failure',
		video: 'off',
		screenshot: 'only-on-failure'
	},

	projects: [
		{
			name: 'gate',
			testDir: './tests/playwright/specs/gate',
			// Measures what a real layout engine resolved, at a fixed 1080p — its claims are in CSS pixels.
			use: { viewport: { width: 1920, height: 1080 } },
			timeout: 180_000
		},
		{ name: 'flow', testDir: './tests/playwright/specs/flow', timeout: 240_000 },
		{ name: 'probe', testDir: './tests/playwright/specs/probe' },
		{
			name: 'shot',
			testDir: './tests/playwright/specs/shot',
			// DPR 1: these frames get read back by a human or an agent, and anything over 2000px on an axis is
			// unreadable in that pipeline. Retries would also silently overwrite a frame under review.
			use: { deviceScaleFactor: 1 },
			retries: 0
		}
	],

	// Reported once, at the top, instead of once per spec. Unconditional, so knip sees the same graph built or
	// not; the file itself checks for the build.
	globalSetup: './tests/playwright/world/require-build.ts'
});
