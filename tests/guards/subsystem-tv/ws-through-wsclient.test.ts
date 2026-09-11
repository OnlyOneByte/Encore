// guard: the TV route drives its realtime channel through the shared, tested WsClient -- the client
// with the heartbeat, liveness watchdog (#presumeDead), capped-backoff reconnect and page-lifecycle
// rebinding -- and holds NO hand-rolled socket lifecycle of its own.
//
// THE DEFECT. The TV route hand-rolled its own connect()/onclose/backoff socket: it had reconnect but
// none of the heartbeat, liveness watchdog, or page-lifecycle rebinding the tested WsClient gives the
// phone -- so it was missing exactly the failure #presumeDead was written for, a socket that stops
// answering but never fires close. The TV runs unattended for hours on a set-top browser, so it is the
// one that most needs the tested client, and it was the one not using it. WsClient was used only by the
// phone route.
//
// WHY A SOURCE SCAN. Encore has no jsdom/happy-dom; a .svelte route's socket wiring is a property of the
// component source, decidable without rendering. The behaviour WsClient itself provides
// (reconnect/heartbeat/watchdog/wake) is exercised by client.test.ts and liveness.test.ts against a mock
// socket -- those tests now cover the TV path too, because the TV shares that one implementation. This
// guard's job is the integration fact those tests cannot see: that the TV actually routes through
// WsClient and keeps no bespoke duplicate. It reds on base, where the TV had its own copy.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

// Blank out block, line, and HTML comments, PRESERVING newlines, so commented-out wiring can never
// satisfy a positive guard and a commented-out bespoke socket can never fail a negative one.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

const TV_ROUTE = at('apps/core/src/routes/tv/+page.svelte');
const tvSrc = () => stripComments(readFileSync(TV_ROUTE, 'utf8'));

test('the TV route constructs and opens a WsClient for role=tv', () => {
	const src = tvSrc();
	expect(src).toMatch(/import\s*\{[^}]*\bWsClient\b[^}]*\}\s*from\s*['"]\$lib\/ws\/client['"]/);
	expect(src).toMatch(/new\s+WsClient\s*\(/);
	expect(src).toMatch(/\.open\s*\(\s*\)/);
	expect(src).toContain('role=tv');
	expect(src).toMatch(/onEvent\s*:/);
});

test('no hand-rolled socket lifecycle remains on the TV route', () => {
	const src = tvSrc();
	expect(src).not.toMatch(/new\s+WebSocket\s*\(/);
	expect(src).not.toMatch(/\.onclose\s*=/);
	expect(src).not.toMatch(/\.onopen\s*=/);
	expect(src).not.toMatch(/Math\.min\s*\(\s*500\s*\*\s*2\s*\*\*/);
});

test('TV telemetry drops silently via WsClient.send quiet', () => {
	const src = tvSrc();
	expect(src).toMatch(/\.send\s*\([^)]*telemetryFrame[\s\S]*?quiet\s*:\s*true/);
});
