import { afterEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { RoomLink, failureNoticeId } from '$lib/stores/room';
import type { Media } from '$lib/contract';
import { PROCESS_SCARS_KEY } from '$lib/stores/process-scars';

/*
 * A SCAR IS A STAND-IN, AND THE SERVER'S LIVE WORD RETIRES IT. A reload seeds this device's failed-process scars as
 * `failed`, and the next /api/library seed may replace a scar — it is older than anything the server says. But once
 * a live `media:status` has arrived for that song, the seed is the OLDER of the two: every `ready` triggers a library
 * refresh, so a phone that kept the scar mark would swap a live "Making karaoke… 40%" back to whatever the snapshot
 * held. Driven through the link's REAL connect path against a Bun WebSocket server, as room-stale-transport does.
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

const settled = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none'
});

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for the link');
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** A link connected over its real path to a Bun WebSocket server; `send` pushes a server frame to it, `drop` closes
 *  its socket from the server side (a core restart, as the phone sees one), and `library` is what /api/library says. */
async function connected(library: () => object = () => ({ library: [] })): Promise<{
	link: RoomLink;
	send: (frame: object) => void;
	drop: () => void;
	libraryReads: () => number;
}> {
	let socket: ServerWebSocket<unknown> | undefined;
	let reads = 0;
	const server = Bun.serve({
		port: 0,
		fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 404 })),
		websocket: {
			message(ws, raw) {
				if (JSON.parse(String(raw)).type === 'hello') socket = ws;
			}
		}
	});
	restore.push(() => server.stop(true));
	stub('window', new EventTarget());
	stub('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
	stub('location', { protocol: 'http:', host: `127.0.0.1:${server.port}` });
	stub('fetch', (url: string | URL) =>
		String(url).startsWith('/api/me')
			? Promise.resolve(Response.json({ singer: { id: 's1', displayName: 'Ana', color: '#a78bfa' } }))
			: (reads++, Promise.resolve(Response.json(library())))
	);

	const link = new RoomLink();
	restore.push(() => link.close());
	await link.connect();
	await until(() => socket !== undefined);
	return {
		link,
		send: (frame) => socket!.send(JSON.stringify(frame)),
		drop: () => {
			const s = socket;
			socket = undefined;
			s?.close();
		},
		libraryReads: () => reads
	};
}

test('a reconnect re-reads the library, so a phone that missed frames says what a reload says', async () => {
	// A core restart, no worker: the room's verdict is "no maker", but the only frame this phone heard said otherwise.
	let noMakerFailed: string[] = [];
	const { link, send, drop, libraryReads } = await connected(() => ({ library: [], noMakerFailed }));
	link.mergeMedia([settled('x')]);
	send({ type: 'media:status', mediaId: 'x', status: 'failed', pct: 0, restated: true });
	await until(() => link.mediaStatus.get('x')?.status === 'failed');
	await until(() => libraryReads() >= 1);
	const before = libraryReads();
	noMakerFailed = ['x'];
	drop();
	await until(() => libraryReads() > before);
	await until(() => link.mediaStatus.get('x')?.unservable === true);
});

test('a reconnect replaces a status that was being made before the drop with the library row', async () => {
	// Core restarted mid-making with no worker after it: the row now says the job is stuck, and only the re-read
	// can say so (the boot sweep said it before this socket was back).
	let processing: object[] = [];
	const { link, send, drop, libraryReads } = await connected(() => ({ library: [], processing }));
	const song = { ...settled('x'), stemStatus: 'queued' as const };
	link.mergeMedia([song]);
	send({ type: 'media:status', mediaId: 'x', status: 'separating', pct: 40 });
	await until(() => link.mediaStatus.get('x')?.status === 'separating');
	await until(() => libraryReads() >= 1);
	const before = libraryReads();
	processing = [{ media: song, status: 'separating', pct: 0, unservable: true }];
	drop();
	await until(() => libraryReads() > before);
	await until(() => link.mediaStatus.get('x')?.unservable === true);
	expect(link.mediaStatus.get('x')).toMatchObject({ status: 'separating', pct: 0, unservable: true });
});

test("the library's cause replaces a held failure's, both ways", () => {
	const link = new RoomLink();
	link.setMediaStatus('plain', { status: 'failed', pct: 0 });
	link.setMediaStatus('stale', { status: 'failed', pct: 0, unservable: true });
	link.setMediaStatus('cooking', { status: 'separating', pct: 30 });
	link.seedNoMakerFailures(['plain', 'cooking']);
	expect(link.mediaStatus.get('plain')).toMatchObject({ status: 'failed', unservable: true });
	// A maker came while this phone was not listening: not listed any more, so no longer "no maker".
	expect(link.mediaStatus.get('stale')?.unservable).toBeUndefined();
	// Something in flight is fresher than any seed.
	expect(link.mediaStatus.get('cooking')).toMatchObject({ status: 'separating', pct: 30 });
});

test('a restated failure does not restart the scar its first failure left', async () => {
	const store = new Map<string, string>();
	stub('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k)
	});
	const { link, send } = await connected();
	link.mergeMedia([settled('x')]);
	send({ type: 'media:status', mediaId: 'x', status: 'failed', pct: 0, unservable: true });
	await until(() => (store.get(PROCESS_SCARS_KEY) ?? '').includes('"x"'));
	const scarred = store.get(PROCESS_SCARS_KEY);
	// Minutes later a maker joins and the failure is re-told: the scar keeps the expiry the death gave it.
	await new Promise((r) => setTimeout(r, 5));
	send({ type: 'media:status', mediaId: 'x', status: 'failed', pct: 0, restated: true });
	await until(() => link.mediaStatus.get('x')?.unservable === undefined);
	expect(store.get(PROCESS_SCARS_KEY)).toBe(scarred);
});

test('a live status after a scar is kept when a later library seed arrives', async () => {
	const { link, send } = await connected();
	link.seedScars([settled('x')]);
	expect(link.mediaStatus.get('x')).toMatchObject({ status: 'failed' });

	send({ type: 'media:status', mediaId: 'x', status: 'separating', pct: 40 });
	await until(() => link.mediaStatus.get('x')?.status === 'separating');

	link.seedMediaStatus([{ media: { ...settled('x'), stemStatus: 'queued' }, status: 'queued', pct: 0 }]);
	expect(link.mediaStatus.get('x')).toMatchObject({ status: 'separating', pct: 40 });
});

test("the requester's failure notice carries the id Pick another dismisses it by", async () => {
	const { link, send } = await connected();
	link.mergeMedia([settled('x')]);
	const ids: (string | undefined)[] = [];
	link.onError((_message, _kind, id) => ids.push(id));
	send({ type: 'media:status', mediaId: 'x', status: 'failed', pct: 0, requestedBy: 's1' });
	await until(() => ids.length === 1);
	expect(ids).toEqual([failureNoticeId('x')]);
});

test('a restated failure redraws the row but tells the singer nothing a second time', async () => {
	const { link, send } = await connected();
	link.mergeMedia([settled('x')]);
	const notices: string[] = [];
	link.onError((message) => notices.push(message));
	send({ type: 'media:status', mediaId: 'x', status: 'failed', pct: 0, requestedBy: 's1', unservable: true });
	await until(() => notices.length === 1);
	// A maker joined: the same failure, re-sent without the no-maker flag.
	send({ type: 'media:status', mediaId: 'x', status: 'failed', pct: 0, restated: true });
	await until(() => link.mediaStatus.get('x')?.unservable === undefined);
	expect(notices).toHaveLength(1);
});
