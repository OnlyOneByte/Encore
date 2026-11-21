import { afterEach, expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';
import type { Media, ServerEvent } from '$lib/contract';

/*
 * A queue:sync carries only the QUEUED songs' media, so the phone ADDS it to its catalog. Replacing would erase every
 * row search and the library merged in, and "Added Sweet Caroline to the queue" would read as a raw id.
 *
 * The real `connect()` path, with the browser globals it touches stubbed: a fake socket hands the store the same
 * frame the server sends.
 */

const song = (id: string, title: string): Media =>
	({ id, source: 'youtube', sourceRef: id, title, durationSec: 100, stemStatus: 'ready' }) as Media;

const real = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
const g = globalThis as Record<string, unknown>;
let link: RoomLink | undefined;

afterEach(() => {
	link?.close();
	globalThis.fetch = real.fetch;
	globalThis.WebSocket = real.WebSocket;
	delete g.window;
	delete g.location;
});

test('search -> library -> lean sync: titles of rows the sync does not carry still resolve', async () => {
	const sockets: { onmessage: ((ev: { data: string }) => void) | null }[] = [];
	g.window = {};
	g.location = { protocol: 'http:', host: 'box' };
	globalThis.WebSocket = class {
		onopen = null;
		onclose = null;
		onmessage = null;
		send() {}
		close() {}
		constructor() {
			sockets.push(this);
		}
	} as unknown as typeof WebSocket;
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
	globalThis.fetch = (async (url: string) =>
		url === '/api/me'
			? json({ singer: { id: 's1', displayName: 'Ana', color: '#f80', joinedAt: 1 } })
			: json({ library: [song('lib', 'Library Song')] })) as unknown as typeof fetch;

	link = new RoomLink();
	await link.connect();
	await link.refreshLibrary();
	link.mergeMedia([song('hit', 'Sweet Caroline')]); // what the search tab does with its answer

	const sync: ServerEvent = {
		type: 'queue:sync',
		rev: 1,
		entries: [{ id: 'e1', mediaId: 'q', singerId: 's1', status: 'queued', rotationSeq: 0, addedAt: 1 }],
		media: [song('q', 'Queued Song')]
	};
	sockets[0]!.onmessage!({ data: JSON.stringify(sync) });

	expect(link.titleOf('hit')).toBe('Sweet Caroline');
	expect(link.titleOf('lib')).toBe('Library Song');
	expect(link.titleOf('q')).toBe('Queued Song');
});
