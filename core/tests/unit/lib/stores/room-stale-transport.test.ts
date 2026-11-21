import { afterEach, expect, test } from 'bun:test';
import { read } from '$test';
import { RoomLink } from '$lib/stores/room';

/*
 * "THAT SONG ALREADY ENDED.", THE HALF OF BE-04 A GUEST SEES. The server drops a skip/restart/seek/key/guide naming a
 * song that is no longer current and tells ONLY the sender (`player:stale`); the link hands that to whoever
 * registered `onStaleTransport` (the layout's toast). Both hops broke silently before this file: dropping
 * `sendToOrigin` from server.ts, or the `player:stale` line from the link, left every unit test green.
 *
 * The link runs its REAL connect path against a real Bun WebSocket server: only `fetch` for /api/me and the
 * browser globals the socket client listens on are stood in.
 */

const restore: (() => void)[] = [];
afterEach(() => {
	for (const fn of restore.splice(0).reverse()) fn();
});

function stub<K extends string>(key: K, value: unknown): void {
	const g = globalThis as Record<string, unknown>;
	const had = key in g;
	const old = g[key];
	g[key] = value;
	restore.push(() => (had ? (g[key] = old) : delete g[key]));
}

test('a player:stale frame reaches the onStaleTransport handler', async () => {
	const server = Bun.serve({
		port: 0,
		fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 404 })),
		websocket: {
			message(ws, raw) {
				if (JSON.parse(String(raw)).type === 'hello') ws.send(JSON.stringify({ type: 'player:stale', cmd: 'guide' }));
			}
		}
	});
	restore.push(() => server.stop(true));
	stub('window', new EventTarget());
	stub('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
	stub('location', { protocol: 'http:', host: `127.0.0.1:${server.port}` });
	const realFetch = globalThis.fetch;
	stub('fetch', (url: string | URL) =>
		String(url).startsWith('/api/me')
			? Promise.resolve(Response.json({ singer: { id: 's1', displayName: 'Ana', color: '#a78bfa' } }))
			: String(url).startsWith('/')
				? Promise.resolve(Response.json({ library: [] }))
				: realFetch(url)
	);

	const link = new RoomLink();
	restore.push(() => link.close());
	// The handler is told WHICH command went stale: the phone words the notice per command.
	const heard = new Promise<string>((resolve) => link.onStaleTransport((cmd) => resolve(`stale:${cmd}`)));
	await link.connect();
	const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('nothing'), 3000));
	// Not `skip`, the one a hard-coded value would most likely name.
	expect(await Promise.race([heard, timeout])).toBe('stale:guide');
});

test('server.ts hands the player-command path its origin, so only the sender hears a stale tap', () => {
	// The wiring is one argument in the transport switch; `transport-target.test.ts` proves what the handler does with it.
	const serverTs = read('server.ts');
	expect(serverTs).toContain('handlePlayerCommand(evt.command, deps, sendToOrigin);');
});
