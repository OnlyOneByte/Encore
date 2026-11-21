// GET /api/library is gzipped for a client that asks, and decodes to the SAME JSON it sends uncompressed. Drives the
// real handler against a stub app exposing only what the route reads.
import { test, expect, afterEach } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { GET } from '$routes/api/library/+server';
import { acceptsGzip } from '$lib/server/http/gzip-json';
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
		jobs: { findOutstandingForMedia: () => undefined }
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
