import { afterEach, expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';
import { handleQueueCommand } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { activeScars } from '$lib/stores/process-scars';
import { processingGroupIds } from '$lib/readiness';
import type { Media, ServerEvent } from '$lib/contract';

/*
 * A queue:sync carries only the QUEUED songs' media, so the phone ADDS it to its catalog. Replacing would erase every
 * row search and the library merged in, and "Added Sweet Caroline to the queue" would read as a raw id. Because the
 * phone no longer gets the whole library every 15 s, a row can also outlive the song: these tests pin what the guest
 * sees then.
 *
 * The real `connect()` path, with the browser globals it touches stubbed: a fake socket hands the store the same
 * frame the server sends.
 */

const song = (id: string, title: string, over: Partial<Media> = {}): Media =>
	({ id, source: 'youtube', sourceRef: id, title, durationSec: 100, stemStatus: 'ready', ...over }) as Media;

const real = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
const g = globalThis as Record<string, unknown>;
let link: RoomLink | undefined;
/** When set, /api/process answers only once this resolves, so a test can order the two refusals of one tap. */
let holdProcess: Promise<void> | undefined;

afterEach(() => {
	link?.close();
	holdProcess = undefined;
	globalThis.fetch = real.fetch;
	globalThis.WebSocket = real.WebSocket;
	delete g.window;
	delete g.location;
	delete g.localStorage;
});

/** A real-enough `localStorage`, so a scar is written, read back and cleared the way a browser keeps it. */
function memoryStorage(): Storage {
	const data = new Map<string, string>();
	return {
		get length() {
			return data.size;
		},
		clear: () => data.clear(),
		getItem: (k) => data.get(k) ?? null,
		key: (i) => [...data.keys()][i] ?? null,
		removeItem: (k) => void data.delete(k),
		setItem: (k, v) => void data.set(k, String(v))
	};
}

/** A connected link, the server's frames delivered through `deliver`, and every notice it raised in `notices`. */
async function connected() {
	const sockets: { onmessage: ((ev: { data: string }) => void) | null; sent: string[] }[] = [];
	g.window = {};
	g.location = { protocol: 'http:', host: 'box' };
	globalThis.WebSocket = class {
		onopen = null;
		onclose = null;
		onmessage = null;
		sent: string[] = [];
		send(data: string) {
			this.sent.push(data);
		}
		close() {}
		constructor() {
			sockets.push(this);
		}
	} as unknown as typeof WebSocket;
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
	globalThis.fetch = (async (url: string) => {
		if (url === '/api/process') await holdProcess;
		return url === '/api/me'
			? json({ singer: { id: 's1', displayName: 'Ana', color: '#f80', joinedAt: 1 } })
			: url === '/api/process'
				? new Response(JSON.stringify({ error: 'unknown media' }), { status: 409 }) // as process/+server.ts refuses
				: json({ library: [song('lib', 'Library Song')] });
	}) as unknown as typeof fetch;

	link = new RoomLink();
	const notices: string[] = [];
	link.onError((m) => notices.push(m));
	await link.connect();
	await link.refreshLibrary();
	return {
		link,
		notices,
		socket: sockets[0]!,
		deliver: (e: ServerEvent) => sockets[0]!.onmessage!({ data: JSON.stringify(e) })
	};
}

const syncOf = (media: Media[], rev = 1): ServerEvent => ({
	type: 'queue:sync',
	rev,
	entries: [{ id: 'e1', mediaId: 'q', singerId: 's1', status: 'queued', rotationSeq: 0, addedAt: 1 }],
	media
});

test('search -> library -> lean sync: titles of rows the sync does not carry still resolve', async () => {
	const { link, deliver } = await connected();
	link.mergeMedia([song('hit', 'Sweet Caroline')]); // what the search tab does with its answer
	deliver(syncOf([song('q', 'Queued Song')]));

	expect(link.titleOf('hit')).toBe('Sweet Caroline');
	expect(link.titleOf('lib')).toBe('Library Song');
	expect(link.titleOf('q')).toBe('Queued Song');
});

test('the catalog only grows: a raw hit survives a sync, a status event, a library refresh and another sync', async () => {
	// The search page drops an open result whose id leaves the catalog, reading that as "deleted" (#songGone). That
	// is only true while nothing else ever removes a row, which is what this pins.
	const { link, deliver } = await connected();
	const hits = [song('raw', 'Raw Hit', { stemStatus: 'none' }), song('ready', 'Ready Hit')];
	link.mergeMedia(hits); // what the search tab does with its answer
	deliver(syncOf([song('q', 'Queued Song')]));
	deliver({ type: 'media:status', mediaId: 'raw', status: 'queued', pct: 10 });
	await link.refreshLibrary();
	deliver(syncOf([song('q', 'Queued Song')], 2));

	for (const id of ['raw', 'ready', 'lib', 'q']) expect(link.mediaCatalog.has(id), id).toBe(true);
});

test("a sync's copy of a song REPLACES the phone's older copy of it", async () => {
	// A phone that reconnects after its queued song turned ready holds the pre-ready row; the sync's is the truth.
	const { link, deliver } = await connected();
	link.mergeMedia([song('q', 'Old Title', { stemStatus: 'queued' })]);
	const fresh = song('q', 'Queued Song', { instrumentalRef: 'derived/stems/q/instrumental.flac' });
	deliver(syncOf([fresh]));

	expect(link.mediaCatalog.get('q')).toEqual(fresh);
});

test('tapping a song deleted since the search: plain copy, and the row leaves this phone', async () => {
	const { link, notices, socket, deliver } = await connected();
	link.mergeMedia([song('gone', 'Deleted Song', { stemStatus: 'none' })]);
	link.queue!.addSong('gone');

	// The server's OWN refusal for that add, so the reason the store parses is the one the hub really sends.
	const cmd = JSON.parse(socket.sent.find((s) => s.includes('queue:command'))!).command;
	const sent: ServerEvent[] = [];
	const deps = { state: new AuthoritativeState(), publish: () => {}, mediaById: new Map(), actorSingerId: 's1' };
	handleQueueCommand(cmd, deps, (e) => sent.push(e));
	expect(sent[0]?.type).toBe('op:reject');
	deliver(sent[0]!);

	expect(notices).toEqual(["That song isn't in the library any more."]);
	expect(link.mediaCatalog.has('gone')).toBe(false);
});

test('a tap is refused twice, by the process and by the add, and the guest is told once', async () => {
	const { link, notices, socket, deliver } = await connected();
	link.mergeMedia([song('gone', 'Deleted Song', { stemStatus: 'none' })]);
	link.queue!.addSong('gone');
	await link.requestProcess('gone');
	const cmd = JSON.parse(socket.sent.find((s) => s.includes('queue:command'))!).command;
	deliver({ type: 'op:reject', clientOpId: cmd.clientOpId, reason: 'unknown media: gone' });

	expect(notices).toEqual(["That song isn't in the library any more."]);
	expect(link.mediaCatalog.has('gone')).toBe(false);
});

/** The server's refusal of the newest add this phone sent. */
function rejectLastAdd(socket: { sent: string[] }, mediaId: string): ServerEvent {
	const adds = socket.sent.filter((s) => s.includes('queue:command'));
	const cmd = JSON.parse(adds.at(-1)!).command;
	return { type: 'op:reject', clientOpId: cmd.clientOpId, reason: `unknown media: ${mediaId}` };
}

test('a refused add leaves no failed status behind: the song re-added later is not shown as failed', async () => {
	const { link, socket, deliver } = await connected();
	link.mergeMedia([song('x', 'Comeback Song', { stemStatus: 'none' })]);
	deliver({ type: 'media:status', mediaId: 'x', status: 'failed', pct: 0 });
	link.queue!.addSong('x');
	deliver(rejectLastAdd(socket, 'x')); // the add itself is refused: unknown media

	link.mergeMedia([song('x', 'Comeback Song', { stemStatus: 'none' })]); // the song is back, e.g. re-imported
	expect(link.mediaStatus.get('x')).toBeUndefined();
});

test('every tap on a deleted library song is told, and the song leaves the shelf', async () => {
	const { link, notices, socket, deliver } = await connected();
	expect(link.library.map((m) => m.id)).toEqual(['lib']);
	for (const tap of [1, 2]) {
		link.queue!.addSong('lib');
		deliver(rejectLastAdd(socket, 'lib'));
		expect(notices.length, `tap ${tap}`).toBe(tap);
	}
	expect(new Set(notices)).toEqual(new Set(["That song isn't in the library any more."]));
	expect(link.library).toEqual([]);
});

test('told once per tap whichever refusal lands first, and again on the next tap', async () => {
	const { link, notices, socket, deliver } = await connected();
	link.mergeMedia([song('gone', 'Deleted Song', { stemStatus: 'none' })]);
	// Tap 1: the add's refusal lands while the process request is still in flight.
	let release!: () => void;
	holdProcess = new Promise((r) => (release = r));
	link.queue!.addSong('gone');
	const processing = link.requestProcess('gone');
	deliver(rejectLastAdd(socket, 'gone'));
	release();
	await processing;
	expect(notices.length).toBe(1);
	// Tap 2: the process refusal lands first, while the add is pending.
	holdProcess = undefined;
	link.queue!.addSong('gone');
	await link.requestProcess('gone');
	deliver(rejectLastAdd(socket, 'gone'));
	expect(notices.length).toBe(2);
	// Tap 3: a process on its own (the stalled card's retry), refused with nothing else in flight.
	await link.requestProcess('gone');
	expect(notices).toEqual(Array(3).fill("That song isn't in the library any more."));
});

test("a failed process this phone never fetched names the song, from the failure's own row", async () => {
	const { notices, deliver } = await connected();
	deliver({
		type: 'media:status',
		mediaId: 'adm',
		status: 'failed',
		pct: 0,
		media: song('adm', 'Admin Song', { stemStatus: 'none' })
	});

	expect(notices).toEqual(["Couldn't make karaoke for “Admin Song” — try again."]);
});

test('a failed song refused as deleted stays gone after the next sync: no scar puts it back', async () => {
	// The search ran while the song was still processing, so it sits in the open search's processing group.
	g.localStorage = memoryStorage();
	const { link, notices, deliver } = await connected();
	const row = song('sc', 'Scarred Song', { stemStatus: 'queued' });
	const processingResults = [row];
	link.mergeMedia(processingResults);
	deliver({ type: 'media:status', mediaId: 'sc', status: 'failed', pct: 0 }); // the scar is recorded
	expect(activeScars().map((m) => m.id)).toEqual(['sc']);

	await link.requestProcess('sc'); // the retry is refused: 409 unknown media, so #songGone
	deliver(syncOf([song('q', 'Queued Song')], 2));

	expect(notices.at(-1)).toBe("That song isn't in the library any more.");
	expect(link.mediaCatalog.has('sc')).toBe(false);
	// The processing group, read the way `routes/+page.svelte` draws it: ids whose catalog row exists.
	expect([...processingGroupIds(processingResults)].filter((id) => link.mediaCatalog.get(id))).toEqual([]);
	// And a reload would not seed it back either.
	expect(activeScars()).toEqual([]);
});
