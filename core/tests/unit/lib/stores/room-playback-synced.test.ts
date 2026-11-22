import { afterEach, expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';
import type { PlaybackState, ServerEvent } from '$lib/contract';

/*
 * `playbackSynced` tells "nothing is playing" from "not told yet". /queue arms its card arrival on it: on a hard load
 * `hello` answers `queue:sync` and then `playback:state`, and a card read in between came WITH the page, not with a
 * song starting. Like `queue.synced` it never goes back to false: a reconnect's hello replaces the state, it does
 * not un-know it. A Leave needs no reset either: joining again reloads the page (`JoinLanding`), so a new link
 * starts at false.
 *
 * Real connect path against a real Bun WebSocket server that sends what `hello` sends; only `fetch` is stood in.
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

const playing = (currentEntryId: string | null): PlaybackState => ({
	currentEntryId,
	positionSec: 0,
	isPlaying: currentEntryId !== null,
	keyShift: 0,
	background: null,
	guideLevel: null
});

type Ws = { send(data: string): void; close(): void };

async function joined() {
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
	// Every /api/me is a join, so a reconnect's re-check keeps the phone in the room.
	stub('fetch', (url: string | URL) =>
		Promise.resolve(
			String(url).startsWith('/api/me')
				? Response.json({ singer: { id: 's1', displayName: 'Maya', color: '#a78bfa' } })
				: Response.json({ library: [] })
		)
	);
	const link = new RoomLink();
	restore.push(() => link.close());
	await link.connect();
	const until = async (ok: () => boolean, what: string) => {
		for (let t = 0; t < 60 && !ok(); t++) await Bun.sleep(50);
		if (!ok()) throw new Error(`timed out waiting for ${what}`);
	};
	await until(() => link.connected && open.size === 1, 'the first socket');
	const send = (e: ServerEvent) => {
		for (const ws of open) ws.send(JSON.stringify(e));
	};
	/** Drop every socket from the server end, and wait for the phone to be back. */
	const drop = async () => {
		const before = sockets;
		for (const ws of [...open]) ws.close();
		await until(() => sockets > before && link.connected && open.size === 1, 'the reconnect');
	};
	return { link, send, drop, until };
}

const sync: ServerEvent = { type: 'queue:sync', rev: 1, entries: [] };

test('false until the first playback:state, which a queue:sync alone does not stand in for', async () => {
	const { link, send, until } = await joined();
	expect(link.playbackSynced).toBe(false);
	send(sync);
	await until(() => !!link.queue?.synced, 'the queue:sync');
	expect(link.playbackSynced).toBe(false);
	send({ type: 'playback:state', state: playing('e1'), rev: 1 });
	await until(() => link.playbackSynced, 'the playback:state');
	expect(link.playback.currentEntryId).toBe('e1');
});

test('an idle room counts: a playback:state with nothing playing still sets it', async () => {
	const { link, send, until } = await joined();
	send({ type: 'playback:state', state: playing(null), rev: 1 });
	await until(() => link.playbackSynced, 'the playback:state');
	expect(link.playback.currentEntryId).toBeNull();
});

test('a reconnect keeps it, and the new hello replaces the state', async () => {
	const { link, send, drop, until } = await joined();
	send({ type: 'playback:state', state: playing('e1'), rev: 1 });
	await until(() => link.playbackSynced, 'the first playback:state');
	await drop();
	// Between the reconnect and its hello the phone still knows the last state, not the default.
	expect(link.playbackSynced).toBe(true);
	expect(link.playback.currentEntryId).toBe('e1');
	send({ type: 'playback:state', state: playing('e2'), rev: 2 });
	await until(() => link.playback.currentEntryId === 'e2', 'the reconnect hello');
	expect(link.playbackSynced).toBe(true);
});
