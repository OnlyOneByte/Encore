// guard: nothing under `tests/` speaks the Chrome DevTools Protocol by hand. Two probes grew private CDP clients
// because the shared Playwright driver lacked the verb each wanted, and one rotted silently — dialling a debugging
// port that no longer existed while no command ran it. Add a verb to tests/e2e/driver.mjs instead; Playwright's own
// `context.newCDPSession` stays allowed, since the ban is on hand-rolling the transport.

import { test, expect } from 'bun:test';
import { filesUnder, read, relative } from '@encore/test-support';

/**
 * The marks of a hand-rolled transport. Each matches a code SHAPE — a version-endpoint fetch, a socket on
 * the debugger URL, a quoted domain being SENT — not the bare protocol words, so prose must not red.
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

// Exempt for ONE construct, `newCDPSession` (no Playwright API exists for safe-area insets), narrowed to the
// construct so a `/json/version` fetch in `driver.mjs` itself still reds.
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
	// Both directions: the driver's own header discusses these names to say they are gone, so prose must not red
	// while real transport code must, each shape caught by exactly the pattern that names it.
	const prose = '// we used to fetch /json/version and open the webSocketDebuggerUrl by hand';
	for (const { re } of HAND_ROLLED) expect(re.test(codeOnly(prose))).toBe(false);

	const block = '/*\n * `send("Target.createTarget")` was how a page got made here.\n */\nconst x = 1;';
	for (const { re } of HAND_ROLLED) expect(re.test(codeOnly(block))).toBe(false);

	const version = 'const v = await fetch(`http://127.0.0.1:${p}/json/version`).then((r) => r.json());';
	expect(HAND_ROLLED[0]!.re.test(codeOnly(version))).toBe(true);
	expect(HAND_ROLLED[1]!.re.test(codeOnly('const ws = new WebSocket(v.webSocketDebuggerUrl);'))).toBe(true);
	expect(HAND_ROLLED[2]!.re.test(codeOnly("await this.send('Target.createBrowserContext');"))).toBe(true);
	expect(HAND_ROLLED[3]!.re.test(codeOnly('spawn(chrome, [`--remote-debugging-port=${port}`]);'))).toBe(true);
});

test("Playwright's own CDP session is what the driver uses, and only for what has no API", () => {
	// The exemption is a claim about the driver, asserted rather than assumed: a hand-rolled replacement reds the
	// first test, dropping the construct reds here, and the session must be released rather than left attached.
	const driver = read(DRIVER);
	expect(driver).toContain('newCDPSession');
	expect(driver).toContain('setSafeAreaInsetsOverride');

	const code = codeOnly(driver);
	expect(code).not.toMatch(/\/json\/version/);
	expect(code).not.toMatch(/webSocketDebuggerUrl/);

	expect(driver).toContain('cdp.detach()');
});
