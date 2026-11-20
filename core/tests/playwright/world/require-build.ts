// `bun run build` output. The gate and every flow serve the BUILT app, so an unbuilt tree is an environment
// error with the remedy printed — never a skip. This repo already ruled that a permanently-skipped test is
// indistinguishable from the rot it was meant to catch.
//
// Its whole job is to fail with the remedy rather than let 30 specs each time out against a core that is
// serving `Run bun run build for the UI` as plain text. An ERROR, not a skip: the gate's rule is that there is
// no exit 2 — a missing build, a missing Chromium and a core that will not answer /health are all failures
// with the fix printed.
import { existsSync } from 'node:fs';

export default function requireBuild(): void {
	if (existsSync(new URL('../../../build/index.js', import.meta.url))) return;
	throw new Error(
		'No build/index.js — the app is not built, so every spec would drive a placeholder page.\n' +
			'  Fix:  bun run build\n' +
			'  Then: bun run pw            (or bun run gate:measured for leg 8 alone)'
	);
}
