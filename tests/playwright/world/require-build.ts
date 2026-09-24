// Runs only when build/index.js is absent, and its whole job is to fail with the remedy rather than let 30
// specs each time out against a core that is serving `Run bun run build for the UI` as plain text.
//
// An ERROR, not a skip: the gate's rule is that there is no exit 2 — a missing build, a missing Chromium and a
// core that will not answer /health are all failures with the fix printed.
export default function requireBuild(): never {
	throw new Error(
		'No build/index.js — the app is not built, so every spec would drive a placeholder page.\n' +
			'  Fix:  bun run build\n' +
			'  Then: bun run pw            (or bun run gate:measured for leg 7 alone)'
	);
}
