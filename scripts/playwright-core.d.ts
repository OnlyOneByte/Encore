// Ambient types for the ONE `playwright-core` API surface scripts/shot.mjs touches.
//
// playwright-core is intentionally NOT a dependency of this package (see e2e/driver.mjs's header:
// the e2e flow speaks CDP directly precisely to avoid an undeclared playwright-core). shot.mjs
// is a standalone eyes-on screenshot helper that drives the cached toolbox chromium; it is never
// imported by the app or the test suite. This declaration lets the type gate cover shot.mjs
// without adding a runtime dependency, a lockfile entry, or a version to drift.
declare module 'playwright-core' {
	interface Page {
		goto(
			url: string,
			options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' }
		): Promise<unknown>;
		screenshot(options: { path: string }): Promise<unknown>;
	}
	interface Browser {
		newPage(options?: {
			viewport?: { width: number; height: number } | null;
			deviceScaleFactor?: number;
		}): Promise<Page>;
		close(): Promise<void>;
	}
	interface BrowserType {
		launch(options?: { executablePath?: string; headless?: boolean; args?: string[] }): Promise<Browser>;
	}
	export const chromium: BrowserType;
}
