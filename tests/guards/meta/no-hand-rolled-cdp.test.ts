// guard: nothing under `tests/` speaks the Chrome DevTools Protocol by hand.
//
// THE DEFECT THIS EXISTS FOR. The e2e tree used to drive Chromium through a driver written here: a
// WebSocket to `/json/version`'s `webSocketDebuggerUrl`, a message-id counter, a pending-promise map,
// and `Target.*` / `Runtime.evaluate` / `Page.navigate` plumbing. That driver was replaced with
// Playwright — and then TWO probes grew their own private copies anyway, because the shared driver did
// not expose the one or two commands each of them wanted:
//
//   p6-lyrics             a second connection, for `Network.setCacheDisabled`
//   p8-presence-resilience  a full `Cdp` + `CdpPage` pair reimplementing evaluate, goto, click,
//                         waitFor, screenshot, viewport and network emulation
//
// Both were reasonable local decisions and both were wrong globally: the second one silently rotted.
// When the Chromium spawn blocks came out, `p8` kept its CDP client and lost the browser it dialled,
// so it failed with "Unable to connect" — and nothing said so, because no command ran it. The fix in
// each case was a native Playwright verb on the shared driver (`newPage({ initScript })` for script
// injection, `setOffline` for severing a socket, `bypassCacheFor` for the cache), which is what this
// guard now protects: reach for the driver, or add a verb to it, but do not grow a third client.
//
// WHAT IS STILL ALLOWED, and why it is not the same thing. `driver.mjs` uses Playwright's OWN
// `context.newCDPSession(page)` for `Emulation.setSafeAreaInsetsOverride`, which has no Playwright
// API at all. That is the library's supported escape hatch: no socket, no id counter, no target
// discovery, no reconnection semantics to get wrong. The ban is on hand-rolling the transport, not on
// the protocol existing.

import { test, expect } from 'bun:test';
import { filesUnder, read, relative } from '@encore/test-support';

/**
 * The marks of a hand-rolled transport, as opposed to a protocol name appearing in prose.
 *
 * Each one is a thing you only write if you are building the connection yourself. A comment that
 * mentions `Runtime.evaluate` while explaining why it is gone must NOT red — which is why the patterns
 * match code shapes (a fetch of the version endpoint, a socket opened on the debugger URL, a quoted
 * domain name being SENT) rather than the bare words.
 */
const HAND_ROLLED = [
	{
		id: 'version endpoint',
		re: /\/json\/version/,
		why: 'fetching the DevTools version endpoint is how a hand-rolled client discovers the socket'
	},
	{
		id: 'debugger socket',
		re: /webSocketDebuggerUrl/,
		why: 'opening the debugger WebSocket directly is the transport Playwright already owns'
	},
	{
		id: 'protocol send',
		re: /\bsend\(\s*['"](?:Target|Runtime|Page|Network|Emulation|Input|DOM)\.[A-Za-z]+['"]/,
		why: 'sending a raw CDP command means a private client exists; add a verb to driver.mjs instead'
	},
	{
		id: 'debugging port flag',
		re: /--remote-debugging-port/,
		why: 'the driver launches its own browser; a debugging port means something is spawning a second one'
	}
];

/**
 * `driver.mjs` is exempt for ONE construct: Playwright's own `newCDPSession`. Named by path and
 * narrowed to that construct rather than exempting the file, so the rest of the driver stays guarded —
 * if it ever grows a `/json/version` fetch, this guard still reds on it.
 */
const DRIVER = 'tests/e2e/driver.mjs';
const SELF = 'tests/guards/meta/no-hand-rolled-cdp.test.ts';

/** Blank comments, preserving newlines, so prose explaining the old mechanism cannot red the scan. */
function codeOnly(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{(])\/\/[^\n]*/g, '$1 ');
}

test('no file under tests/ hand-rolls a CDP connection', () => {
	const files = filesUnder('tests', ['.ts', '.mjs']).map((f) => relative(f));
	// Non-vacuity: the walk reached the tree. An empty list would make this guard a decoration.
	expect(files.length).toBeGreaterThan(300); // @nvf-floor files.length

	/** @type {string[]} */
	const offenders: string[] = [];
	for (const rel of files) {
		if (rel === SELF) continue; // carries the patterns as fixtures, below
		const code = codeOnly(read(rel));
		for (const { id, re, why } of HAND_ROLLED) {
			if (!re.test(code)) continue;
			offenders.push(`${rel}: ${id} — ${why}`);
		}
	}

	expect(
		offenders,
		'a file under tests/ is building its own DevTools connection. The shared driver at tests/e2e/driver.mjs ' +
			'launches and owns the browser; if it lacks the verb you need, ADD THE VERB there — that is how ' +
			'setOffline, bypassCacheFor and newPage({ initScript }) came to exist. A private client is how one ' +
			'probe came to dial a debugging port that no longer existed while no command ran it.'
	).toEqual([]);
});

test('the scan reads code, not the prose that explains the removal', () => {
	/*
	 * Both directions. The driver's own header discusses `Runtime.evaluate` and `/json/version` at
	 * length precisely to say they are gone; that must not red. Real transport code must still be caught.
	 */
	const prose = '// we used to fetch /json/version and open the webSocketDebuggerUrl by hand';
	for (const { re } of HAND_ROLLED) expect(re.test(codeOnly(prose))).toBe(false);

	const block = '/*\n * `send("Target.createTarget")` was how a page got made here.\n */\nconst x = 1;';
	for (const { re } of HAND_ROLLED) expect(re.test(codeOnly(block))).toBe(false);

	// …and the real shapes, each caught by exactly the pattern that names it.
	const version = 'const v = await fetch(`http://127.0.0.1:${p}/json/version`).then((r) => r.json());';
	expect(HAND_ROLLED[0]!.re.test(codeOnly(version))).toBe(true);
	expect(HAND_ROLLED[1]!.re.test(codeOnly('const ws = new WebSocket(v.webSocketDebuggerUrl);'))).toBe(true);
	expect(HAND_ROLLED[2]!.re.test(codeOnly("await this.send('Target.createBrowserContext');"))).toBe(true);
	expect(HAND_ROLLED[3]!.re.test(codeOnly("spawn(chrome, [`--remote-debugging-port=${port}`]);"))).toBe(true);
});

test("Playwright's own CDP session is what the driver uses, and only for what has no API", () => {
	/*
	 * The exemption is a claim about the driver, so it is asserted rather than assumed. If a future edit
	 * replaces `newCDPSession` with a hand-rolled socket, the first test above reds; if it removes the
	 * construct entirely because Playwright grew an API for safe-area insets, THIS reds and the comment
	 * above it stops being true. Either way the two stay in step.
	 */
	const driver = read(DRIVER);
	expect(driver).toContain('newCDPSession');
	expect(driver).toContain('setSafeAreaInsetsOverride');

	// It must be Playwright's session, not a socket of our own.
	const code = codeOnly(driver);
	expect(code).not.toMatch(/\/json\/version/);
	expect(code).not.toMatch(/webSocketDebuggerUrl/);

	// And the session must be released rather than left attached for the life of the page.
	expect(driver).toContain('cdp.detach()');
});
