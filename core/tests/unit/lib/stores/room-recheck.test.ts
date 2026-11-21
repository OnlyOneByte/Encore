import { afterEach, expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';

/*
 * "GREEN BUT REFUSED". A phone whose session went away mid-party (Leave on another tab, cookies cleared, a room reset)
 * kept its socket until the next drop; then the server upgraded the cookieless reconnect to an anonymous spectator, the
 * dot went green, and every tap was refused with nothing saying why. The link asks /api/me once on every RE-connect
 * now, and a 401 there settles it as `not-joined` with the old name kept for the join screen.
 *
 * Real connect path against a real Bun WebSocket server that can drop its sockets; only `fetch` is stood in.
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

type Ws = { close(): void };

/** A joined phone. `me` answers every /api/me AFTER the first, which is always a join. */
async function joined(me: () => Response | Promise<Response>) {
	const open = new Set<Ws>();
	let sockets = 0;
	const server = Bun.serve({
		port: 0,
		fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 404 })),
		websocket: {
			open: (ws) => void (open.add(ws), sockets++),
			close: (ws) => void open.delete(ws),
			message() {}
		}
	});
	restore.push(() => server.stop(true));
	stub('window', new EventTarget());
	stub('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
	stub('location', { protocol: 'http:', host: `127.0.0.1:${server.port}` });
	let asked = 0;
	stub('fetch', (url: string | URL) => {
		if (!String(url).startsWith('/api/me')) return Promise.resolve(Response.json({ library: [] }));
		return Promise.resolve().then(() =>
			asked++ === 0 ? Response.json({ singer: { id: 's1', displayName: 'Maya', color: '#a78bfa' } }) : me()
		);
	});
	const link = new RoomLink();
	restore.push(() => link.close());
	await link.connect();
	const until = async (ok: () => boolean, what: string) => {
		for (let t = 0; t < 60 && !ok(); t++) await Bun.sleep(50);
		if (!ok()) throw new Error(`timed out waiting for ${what}`);
	};
	await until(() => link.connected, 'the first socket');
	/** Drop every socket from the server end, and wait for the phone to be back (or to have given up). */
	const drop = async () => {
		const before = sockets;
		for (const ws of [...open]) ws.close();
		await until(() => sockets > before, 'the reconnect');
		await Bun.sleep(150); // the re-check's answer lands
	};
	return { link, drop, asked: () => asked, open: () => open.size };
}

test('the first connect does not ask twice', async () => {
	const r = await joined(() => new Response('', { status: 401 }));
	await Bun.sleep(150);
	expect(r.asked()).toBe(1);
	expect(r.link.status).toBe('joined');
});

test('a reconnect whose session is gone settles not-joined, keeps the name, and drops the socket', async () => {
	const r = await joined(() => new Response('', { status: 401 }));
	await r.drop();
	expect(r.asked()).toBe(2);
	expect(r.link.status).toBe('not-joined');
	expect(r.link.me).toBeNull();
	expect(r.link.lostName).toBe('Maya');
	expect(r.link.lostColor).toBe('#a78bfa');
	await Bun.sleep(1200); // past a reconnect backoff: nothing dials again
	expect(r.open(), 'the link kept a spectator socket open').toBe(0);
});

test('a reconnect whose session is still there stays joined', async () => {
	const r = await joined(() => Response.json({ singer: { id: 's1', displayName: 'Maya', color: '#a78bfa' } }));
	await r.drop();
	expect(r.asked()).toBe(2);
	expect(r.link.status).toBe('joined');
	expect(r.link.lostName).toBeNull();
	expect(r.open()).toBe(1);
});

test('a reconnect whose re-check fails for another reason proves nothing and stays joined', async () => {
	const r = await joined(() => new Response('', { status: 502 }));
	await r.drop();
	expect(r.link.status).toBe('joined');
	expect(r.link.me?.displayName).toBe('Maya');
});

test('a 401 that lands after the link was closed changes nothing', async () => {
	// The re-check is still out when the app tears the link down (the layout unmounts), and its 401 comes back after.
	const r = await joined(() => Bun.sleep(400).then(() => new Response('', { status: 401 })));
	await r.drop(); // the re-check is in flight
	r.link.close();
	await Bun.sleep(500);
	expect(r.link.status, 'a closed link was settled as not joined').toBe('joined');
	expect(r.link.lostName).toBeNull();
	expect(r.link.me?.displayName).toBe('Maya');
});
