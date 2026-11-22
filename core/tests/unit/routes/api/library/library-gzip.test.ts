// GET /api/library is gzipped for a client that asks, and decodes to the SAME JSON it sends uncompressed. Drives the
// real handler against a stub app exposing only what the route reads.
import { test, expect, afterEach } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { GET } from '$routes/api/library/+server';
import { acceptsGzip, gzipJson } from '$lib/server/http/gzip-json';
import { EMPTY_SONG_PROFILE, type Media } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');

const ready = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: id,
	title: `Song ${id}`,
	durationSec: 200,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}/instrumental.flac`,
	songProfile: { ...EMPTY_SONG_PROFILE }
});

function installApp() {
	const library = Array.from({ length: 200 }, (_, i) => ready(`m${i}`));
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		mediaById: new Map(library.map((m) => [m.id, m])),
		media: {
			listReady: () => library,
			tagsOf: (id: string) => (id === 'm1' ? ['duet'] : []),
			artistFacets: () => [],
			tagFacets: () => []
		},
		jobs: { findOutstandingForMedia: () => undefined },
		state: { entries: [] },
		workerHub: { noMakerMedia: () => [] }
	};
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

const get = (headers: Record<string, string>) =>
	GET({ url: new URL('http://x/api/library'), request: new Request('http://x/api/library', { headers }) } as never);

test('a client that accepts gzip gets gzip, decoding to the same JSON as the plain answer', async () => {
	installApp();
	const plain = await get({});
	const gz = await get({ 'accept-encoding': 'gzip, deflate, br' });

	expect(plain.headers.get('content-encoding')).toBeNull();
	expect(gz.headers.get('content-encoding')).toBe('gzip');
	expect(gz.headers.get('content-type')).toBe('application/json');
	for (const r of [plain, gz]) expect(r.headers.get('vary')).toBe('Accept-Encoding');

	const plainText = await plain.text();
	const zipped = new Uint8Array(await gz.arrayBuffer());
	expect(gunzipSync(zipped).toString()).toBe(plainText);
	expect(zipped.byteLength).toBeLessThan(plainText.length / 4);
	expect(JSON.parse(plainText).tags).toEqual({ m1: ['duet'] });
});

test('Accept-Encoding: gzip, wildcard and q-values, with q=0 a refusal', () => {
	expect(acceptsGzip('gzip')).toBe(true);
	expect(acceptsGzip('br, GZIP;q=0.5')).toBe(true);
	expect(acceptsGzip('*')).toBe(true);
	expect(acceptsGzip('gzip;q=0')).toBe(false);
	expect(acceptsGzip('gzip; q=0.0')).toBe(false);
	expect(acceptsGzip('gzip;q=0, *')).toBe(false);
	expect(acceptsGzip('*;q=0')).toBe(false);
	expect(acceptsGzip('identity, br')).toBe(false);
	expect(acceptsGzip('xgzip')).toBe(false);
	expect(acceptsGzip(null)).toBe(false);
	expect(acceptsGzip('')).toBe(false);
});

test('the compression yields the event loop: a macrotask queued before it runs before it resolves', async () => {
	// A synchronous gzipSync finishes before gzipJson returns, so its promise settles in a MICROtask and the
	// immediate below cannot have run. The async gzip completes on the pool, a later turn, so it has. ~4 MB of
	// poorly compressible text keeps the compression well past one turn of the loop.
	let seed = 1;
	const word = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) >>> 0).toString(36);
	const body = { rows: Array.from({ length: 200_000 }, () => word() + word() + word()) };
	let yielded = false;
	setImmediate(() => (yielded = true));
	const res = await gzipJson(new Request('http://x', { headers: { 'accept-encoding': 'gzip' } }), body);
	expect(yielded, 'gzipJson compressed synchronously and held the event loop').toBe(true);
	expect(res.headers.get('content-encoding')).toBe('gzip');
});
