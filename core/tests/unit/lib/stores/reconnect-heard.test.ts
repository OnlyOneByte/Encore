// The re-connect's "heard since" rule and its keep-a-held-verdict rule, through the link's REAL connect path, with the
// re-connect's /api/library read held open so a frame or a tap can land while it is in flight (round-8 review,
// R8-HEARD-1/2 and R8-FAILED-1, adopted; harness from room-live-scar.test.ts). Then the TV's twin of R8-FAILED-1, and a
// socket that flaps twice inside one library round trip.
import { afterEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { RoomLink } from '$lib/stores/room';
import { seedLiveStatus } from '$lib/tv/catalog';
import { waitingTurns } from '$lib/readiness';
import type { Media, MediaStatus } from '$lib/contract';

const restore: (() => void)[] = [];
afterEach(() => {
	for (const fn of restore.splice(0).reverse()) fn();
});
function stub(key: string, value: unknown): void {
	const g = globalThis as Record<string, unknown>;
	const had = key in g;
	const old = g[key];
	g[key] = value;
	restore.push(() => (had ? (g[key] = old) : delete g[key]));
}
const song = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'queued',
	...over
});
async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for the link');
		await new Promise((r) => setTimeout(r, 10));
	}
}
const settle = () => new Promise((r) => setTimeout(r, 100));

/** `hold()` makes the NEXT /api/library read wait until the returned release is called. */
async function connected(library: () => object) {
	let socket: ServerWebSocket<unknown> | undefined;
	let reads = 0;
	let gate: Promise<void> | null = null;
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
	stub('fetch', async (url: string | URL) => {
		if (String(url).startsWith('/api/me'))
			return Response.json({ singer: { id: 's1', displayName: 'Ana', color: '#a78bfa' } });
		reads++;
		const body = library(); // the snapshot is taken when the server is asked, not when it answers
		const held = gate;
		if (held) await held;
		return Response.json(body);
	});
	const link = new RoomLink();
	restore.push(() => link.close());
	await link.connect();
	await until(() => socket !== undefined);
	return {
		link,
		send: (frame: object) => socket!.send(JSON.stringify(frame)),
		drop: () => {
			const s = socket;
			socket = undefined;
			s?.close();
		},
		reads: () => reads,
		hold: () => {
			let release!: () => void;
			gate = new Promise<void>((r) => (release = r));
			return () => {
				gate = null;
				release();
			};
		},
		reconnected: () => until(() => socket !== undefined)
	};
}

test('R8-HEARD-1: a frame that lands while the re-connect read is in flight beats the older snapshot', async () => {
	const x = song('x');
	let processing: object[] = [];
	const c = await connected(() => ({ library: [], processing }));
	c.link.mergeMedia([x]);
	c.send({ type: 'media:status', mediaId: 'x', status: 'separating', pct: 40 });
	await until(() => c.link.mediaStatus.get('x')?.status === 'separating');
	await until(() => c.reads() >= 1);
	const before = c.reads();
	processing = [{ media: x, status: 'aligning', pct: 90 }];
	const release = c.hold();
	c.drop();
	await c.reconnected();
	await until(() => c.reads() > before);
	// The job fails AFTER the server answered the read, BEFORE the phone has the answer.
	c.send({ type: 'media:status', mediaId: 'x', status: 'failed', pct: 0 });
	await until(() => c.link.mediaStatus.get('x')?.status === 'failed');
	release();
	await settle();
	expect(c.link.mediaStatus.get('x')?.status).toBe('failed');
});

test("R8-HEARD-2: this phone's own Try again during the re-connect read is not undone by the snapshot", async () => {
	const x = song('x');
	const c = await connected(() => ({ library: [], processing: [] }));
	c.link.mergeMedia([x]);
	await until(() => c.reads() >= 1);
	const before = c.reads();
	const release = c.hold();
	c.drop();
	await c.reconnected();
	await until(() => c.reads() > before);
	c.link.setMediaStatus('x', { status: 'queued', pct: 0 }); // the tap's optimistic mark
	release();
	await settle();
	expect(c.link.mediaStatus.get('x')?.status).toBe('queued');
});

test('R8-FAILED-1: a failure heard before the drop survives a re-connect whose snapshot does not list the song', async () => {
	const x = song('x');
	const c = await connected(() => ({ library: [], processing: [] }));
	c.link.mergeMedia([x]);
	c.send({ type: 'media:status', mediaId: 'x', status: 'failed', pct: 0 });
	await until(() => c.link.mediaStatus.get('x')?.status === 'failed');
	await until(() => c.reads() >= 1);
	const before = c.reads();
	c.drop();
	await c.reconnected();
	await until(() => c.reads() > before);
	await settle();
	expect(c.link.mediaStatus.get('x')?.status).toBe('failed');
});

for (const firstAnswersFirst of [true, false])
	test(`a socket that flaps twice inside one read: the first read cannot undo a frame the second heard (${
		firstAnswersFirst ? 'first read answers first' : 'second read answers first'
	})`, async () => {
		const x = song('x');
		const y = song('y');
		let processing: object[] = [];
		const c = await connected(() => ({ library: [], processing }));
		c.link.mergeMedia([x, y]);
		c.send({ type: 'media:status', mediaId: 'y', status: 'separating', pct: 40 });
		await until(() => c.link.mediaStatus.get('y')?.status === 'separating');
		await until(() => c.reads() >= 1);
		processing = [
			{ media: x, status: 'aligning', pct: 90 },
			{ media: y, status: 'aligning', pct: 90 }
		];
		const releaseFirst = c.hold();
		c.drop();
		await c.reconnected();
		await until(() => c.reads() >= 2);
		const releaseSecond = c.hold();
		c.drop();
		await c.reconnected();
		await until(() => c.reads() >= 3);
		c.send({ type: 'media:status', mediaId: 'x', status: 'failed', pct: 0 });
		await until(() => c.link.mediaStatus.get('x')?.status === 'failed');
		for (const release of firstAnswersFirst ? [releaseFirst, releaseSecond] : [releaseSecond, releaseFirst]) {
			release();
			await settle();
		}
		expect(c.link.mediaStatus.get('x')?.status).toBe('failed');
		// And the second read still seeds: `y`, unheard since, takes the snapshot's word over what it held before the drops.
		expect(c.link.mediaStatus.get('y')?.status).toBe('aligning');
	});

// THE TV'S TWIN of R8-FAILED-1 (review nit Z10), and of the held `ready` (Z5). A TV has no scars, and /api/library
// lists neither a plain failure nor a finished song, so a re-connect keeps what it heard. For a failure that is also
// what a reload's lobby says: the same stuck turn, the same words.
const held = (status: MediaStatus) =>
	new Map([['m1', { type: 'media:status' as const, mediaId: 'm1', status, pct: status === 'ready' ? 100 : 0 }]]);
const fold = (m: Map<string, { status: MediaStatus; unservable?: boolean }>, catalog: Media) =>
	waitingTurns(
		[{ singerId: 's', mediaId: 'm1' }],
		() => catalog,
		(id) => m.get(id)
	);

test('a TV that re-connects keeps a failure it heard, and its lobby reads what a reload reads', () => {
	const tv = seedLiveStatus(held('failed'), [], [], { reconnect: true });
	expect(tv.get('m1')?.status).toBe('failed');
	// A failed process settles the song back to un-processed, which is what a reloading TV's catalog then says.
	const settled = song('m1', { stemStatus: 'none' });
	expect(fold(tv, settled)).toEqual(fold(seedLiveStatus(new Map(), [], []), settled));
});

test('a TV that re-connects keeps a `ready` it heard', () => {
	const tv = seedLiveStatus(held('ready'), [], [], { reconnect: true });
	expect(tv.get('m1')?.status).toBe('ready');
});
