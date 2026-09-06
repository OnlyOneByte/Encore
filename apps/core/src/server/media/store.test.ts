// MediaStore — pure config resolver + helpers + LocalMediaStore round-trip + the
// ObjectMediaStore (S3/MinIO) driven by an in-memory fake S3 client (no network).
import { test, expect, beforeEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	resolveMediaStoreConfig,
	normalizePrefix,
	objectKey,
	mediaProxyUrl,
	LocalMediaStore
} from './store';
import { ObjectMediaStore, type S3Like } from './object-store';

// ── pure config resolver ─────────────────────────────────────────────────────────
test('resolveMediaStoreConfig defaults to local', () => {
	expect(resolveMediaStoreConfig({})).toEqual({ kind: 'local' });
	expect(resolveMediaStoreConfig({ MEDIA_STORE: 'local' })).toEqual({ kind: 'local' });
});

test('resolveMediaStoreConfig builds object config from env', () => {
	const cfg = resolveMediaStoreConfig({
		MEDIA_STORE: 'object',
		S3_BUCKET: 'encore-media',
		S3_ENDPOINT: 'https://minio.lan:9000',
		S3_REGION: 'us-west-2',
		S3_PREFIX: '/encore/'
	});
	expect(cfg).toEqual({
		kind: 'object',
		bucket: 'encore-media',
		endpoint: 'https://minio.lan:9000',
		region: 'us-west-2',
		prefix: 'encore/'
	});
});

test('MEDIA_STORE=object WITHOUT a bucket falls back to local (the party must still run)', () => {
	expect(resolveMediaStoreConfig({ MEDIA_STORE: 'object' })).toEqual({ kind: 'local' });
	expect(resolveMediaStoreConfig({ MEDIA_STORE: 'object', S3_BUCKET: '  ' })).toEqual({ kind: 'local' });
});

test('normalizePrefix: trims, strips leading /, ensures one trailing /, empty→undefined', () => {
	expect(normalizePrefix(undefined)).toBeUndefined();
	expect(normalizePrefix('')).toBeUndefined();
	expect(normalizePrefix('encore')).toBe('encore/');
	expect(normalizePrefix('/encore/')).toBe('encore/');
	expect(normalizePrefix('a/b')).toBe('a/b/');
});

test('objectKey joins prefix + ref', () => {
	expect(objectKey('encore/', 'stems/m1.wav')).toBe('encore/stems/m1.wav');
	expect(objectKey(undefined, 'stems/m1.wav')).toBe('stems/m1.wav');
});

test('mediaProxyUrl returns a same-origin /media url for a safe ref, null for traversal', () => {
	process.env.MEDIA_DIR = '/srv/encore/media';
	expect(mediaProxyUrl('stems/m1-instrumental.wav')).toBe('/media/stems/m1-instrumental.wav');
	expect(mediaProxyUrl('../../etc/passwd')).toBeNull();
});

// ── LocalMediaStore (real disk round-trip in a temp dir) ───────────────────────────
let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'encore-store-'));
	process.env.MEDIA_DIR = dir;
});

test('LocalMediaStore put → exists → get round-trips bytes under MEDIA_DIR', async () => {
	const store = new LocalMediaStore();
	expect(await store.exists('stems/x-instrumental.wav')).toBe(false);
	await store.put('stems/x-instrumental.wav', new TextEncoder().encode('INSTRUMENTAL'));
	expect(await store.exists('stems/x-instrumental.wav')).toBe(true);
	const stream = await store.get('stems/x-instrumental.wav');
	expect(stream).not.toBeNull();
	expect(await new Response(stream).text()).toBe('INSTRUMENTAL');
	await rm(dir, { recursive: true, force: true });
});

test('LocalMediaStore refuses an unsafe ref on put and returns null on get/exists', async () => {
	const store = new LocalMediaStore();
	await expect(store.put('../escape.wav', new Uint8Array([1]))).rejects.toThrow('unsafe media ref');
	expect(await store.get('../escape.wav')).toBeNull();
	expect(await store.exists('../escape.wav')).toBe(false);
	expect(store.url('../escape.wav')).toBeNull();
	expect(store.url('stems/ok.wav')).toBe('/media/stems/ok.wav'); // local always proxies same-origin
});

// ── the range capability the /media route serves byte ranges from ──────────────────
// `size` + `getRange` are what let the route answer `206 Partial Content`. Without them the route
// hands a media element the whole file for a `Range: bytes=0-1` probe, and WebKit refuses to play at
// all — see media/http-range.ts. Tested against real bytes on disk because the bug these guard is an
// off-by-one at the slice boundary, which no amount of mocking would surface.

test('LocalMediaStore.size reports the byte length, and null for absent/unsafe refs', async () => {
	const store = new LocalMediaStore();
	expect(await store.size('stems/x-instrumental.flac')).toBeNull(); // absent
	await store.put('stems/x-instrumental.flac', new TextEncoder().encode('0123456789'));
	expect(await store.size('stems/x-instrumental.flac')).toBe(10);
	expect(await store.size('../escape.flac')).toBeNull(); // traversal, before any disk access
	await rm(dir, { recursive: true, force: true });
});

test('LocalMediaStore.getRange treats end as INCLUSIVE, matching HTTP', async () => {
	const store = new LocalMediaStore();
	await store.put('stems/x-instrumental.flac', new TextEncoder().encode('0123456789'));
	const text = async (start: number, end: number) =>
		new Response(await store.getRange('stems/x-instrumental.flac', start, end)).text();

	expect(await text(0, 1)).toBe('01'); // the WebKit probe: two bytes, not one
	expect(await text(3, 5)).toBe('345'); // a mid-file slice keeps both endpoints
	// The final byte is reachable — an exclusive end would drop it and read as a corrupt stream.
	expect(await text(9, 9)).toBe('9');
	// The whole file, which is how the route serves a full 200 with a Content-Length.
	expect(await text(0, 9)).toBe('0123456789');

	await rm(dir, { recursive: true, force: true });
});

test('LocalMediaStore.getRange returns null for an absent or unsafe ref', async () => {
	const store = new LocalMediaStore();
	expect(await store.getRange('stems/missing.flac', 0, 1)).toBeNull();
	expect(await store.getRange('../escape.flac', 0, 1)).toBeNull();
});

test('LocalMediaStore.getRange hands back a Blob of exactly the range length', async () => {
	// Blob-ness is not incidental. Bun sends a ReadableStream body chunked and DROPS an explicit
	// content-length, so returning a stream here would silently cost the response the header a media
	// element reads the resource size from; a Blob lets the runtime set it from `size`. The header
	// itself is a wire-level concern the in-process `Response` does not expose, so it is verified
	// against a live server (`curl -D -`) rather than asserted here — what is asserted is the property
	// the runtime derives it from.
	const store = new LocalMediaStore();
	await store.put('stems/x-instrumental.flac', new TextEncoder().encode('0123456789'));
	const body = await store.getRange('stems/x-instrumental.flac', 2, 4);
	expect(body).toBeInstanceOf(Blob);
	expect((body as Blob).size).toBe(3); // inclusive 2..4
	await rm(dir, { recursive: true, force: true });
});

// ── ObjectMediaStore with an in-memory fake S3 ─────────────────────────────────────
function fakeS3(): S3Like & { store: Map<string, Blob>; presigned: string[] } {
	const store = new Map<string, Blob>();
	const presigned: string[] = [];
	return {
		store,
		presigned,
		file(key: string) {
			return {
				async exists() {
					return store.has(key);
				},
				async write(data: Uint8Array | ReadableStream | Blob) {
					store.set(key, data instanceof Blob ? data : await new Response(data as BodyInit).blob());
				},
				stream() {
					return (store.get(key) ?? new Blob()).stream();
				},
				async stat() {
					return { size: (store.get(key) ?? new Blob()).size };
				},
				slice(start: number, end: number) {
					// mirrors Bun.S3File.slice: EXCLUSIVE end, like Blob.slice
					return (store.get(key) ?? new Blob()).slice(start, end);
				},
				presign(opts?: { expiresIn?: number }) {
					const u = `https://s3.fake/${key}?X-Expires=${opts?.expiresIn ?? 0}`;
					presigned.push(u);
					return u;
				}
			};
		}
	};
}

test('ObjectMediaStore put/exists/get round-trips through the (prefixed) S3 key', async () => {
	const s3 = fakeS3();
	const store = new ObjectMediaStore(s3, { prefix: 'encore/' });
	await store.put('stems/m1.wav', new TextEncoder().encode('STEM'));
	expect([...s3.store.keys()]).toEqual(['encore/stems/m1.wav']);
	expect(await store.exists('stems/m1.wav')).toBe(true);
	expect(await store.exists('stems/missing.wav')).toBe(false);
	expect(await new Response(await store.get('stems/m1.wav')).text()).toBe('STEM');
});

test('ObjectMediaStore.url presigns a direct URL by default', () => {
	const s3 = fakeS3();
	const store = new ObjectMediaStore(s3, { prefix: 'encore/' }, { presignExpiresIn: 1800 });
	const url = store.url('stems/m1.wav');
	expect(url).toBe('https://s3.fake/encore/stems/m1.wav?X-Expires=1800');
	expect(s3.presigned).toHaveLength(1);
});

test('ObjectMediaStore.url proxies same-origin when proxyUrls is set (private bucket)', () => {
	process.env.MEDIA_DIR = '/srv/encore/media';
	const store = new ObjectMediaStore(fakeS3(), { prefix: 'encore/' }, { proxyUrls: true });
	expect(store.url('stems/m1.wav')).toBe('/media/stems/m1.wav');
});

test('ObjectMediaStore.url rejects a traversal ref (never becomes a key)', () => {
	process.env.MEDIA_DIR = '/srv/encore/media';
	const store = new ObjectMediaStore(fakeS3(), {});
	expect(store.url('../../etc/passwd')).toBeNull();
});

// ── ObjectMediaStore range capability (the fix for the WebKit-silent-TV bug) ───────
// Same contract the /media route relies on: size() reports the length, getRange() returns a Blob
// (for Content-Length) over an INCLUSIVE range. If these are absent the route degrades to a
// range-less 200 and Safari/iOS never play — this is exactly what regressed when only the LOCAL
// store implemented them. Asserted through the in-memory fake because the concern is the inclusive/
// exclusive slice boundary, not the wire.

test('ObjectMediaStore.size reports the byte length, and null for an absent ref', async () => {
	const store = new ObjectMediaStore(fakeS3(), { prefix: 'encore/' });
	expect(await store.size('stems/m1.wav')).toBeNull(); // absent
	await store.put('stems/m1.wav', new TextEncoder().encode('0123456789'));
	expect(await store.size('stems/m1.wav')).toBe(10);
});

test('ObjectMediaStore.getRange treats end as INCLUSIVE, matching HTTP, as a Blob', async () => {
	const store = new ObjectMediaStore(fakeS3(), { prefix: 'encore/' });
	await store.put('stems/m1.wav', new TextEncoder().encode('0123456789'));
	const text = async (start: number, end: number) =>
		new Response(await store.getRange('stems/m1.wav', start, end)).text();

	expect(await text(0, 1)).toBe('01'); // the WebKit probe: two bytes, not one
	expect(await text(3, 5)).toBe('345'); // a mid-file slice keeps both endpoints
	// The final byte is reachable — an exclusive end would drop it and read as a corrupt stream.
	expect(await text(9, 9)).toBe('9');
	// A Blob body is what lets the response carry a Content-Length.
	const whole = await store.getRange('stems/m1.wav', 0, 9);
	expect(whole).toBeInstanceOf(Blob);
	expect((whole as Blob).size).toBe(10);
});

test('ObjectMediaStore.getRange returns null for an absent ref', async () => {
	const store = new ObjectMediaStore(fakeS3(), { prefix: 'encore/' });
	expect(await store.getRange('stems/missing.wav', 0, 1)).toBeNull();
});

// PARITY: the /media route serves byte ranges only if BOTH size() and getRange() are functions, and
// a store that omits either silently makes the TV unplayable on WebKit. So the invariant is not "the
// object store has methods" but "every MediaStore answers them identically". Assert both shipped
// stores are callable and agree on the same bytes for the same inclusive range, so a THIRD store
// cannot reopen the bug — the failing state is a store that returns undefined for these members.
test('PARITY: both shipped stores implement size()/getRange() and agree on an inclusive range', async () => {
	const bytes = new TextEncoder().encode('0123456789');

	const local = new LocalMediaStore();
	await local.put('stems/p.flac', bytes);

	const object = new ObjectMediaStore(fakeS3(), { prefix: 'encore/' });
	await object.put('stems/p.flac', bytes);

	for (const store of [local, object] as const) {
		expect(typeof store.size).toBe('function'); // the route's degrade guard keys off this
		expect(typeof store.getRange).toBe('function');
		expect(await store.size!('stems/p.flac')).toBe(10);
		// the WebKit 0-1 probe is the exact case that dies on the range-less path
		expect(await new Response(await store.getRange!('stems/p.flac', 0, 1)).text()).toBe('01');
		expect(await new Response(await store.getRange!('stems/p.flac', 3, 5)).text()).toBe('345');
		const whole = await store.getRange!('stems/p.flac', 0, 9);
		expect(whole).toBeInstanceOf(Blob); // Blob → Content-Length
		expect((whole as Blob).size).toBe(10);
	}
	await rm(dir, { recursive: true, force: true });
});

test('INTEGRATION: a remote worker publishes stems to the bucket; the core reads them back via the SAME key', async () => {
	process.env.MEDIA_DIR = '/srv/encore/media';
	// one shared bucket both sides talk to (the "second box" topology — worker and core only share S3)
	const s3 = fakeS3();
	const config = resolveMediaStoreConfig({ MEDIA_STORE: 'object', S3_BUCKET: 'encore-media', S3_PREFIX: 'encore/' });
	expect(config.kind).toBe('object');

	// CORE side: the store it hands the /media route + the worker:welcome config it would send.
	const coreStore = new ObjectMediaStore(s3, config as Extract<typeof config, { kind: 'object' }>);

	// WORKER side (second box): it received welcome.mediaStore=config and, after Demucs, uploads its
	// local instrumental to the agreed ref. Mirror the worker's objectKey(prefix, ref) layout.
	const ref = 'stems/m1-instrumental.wav';
	const workerStore = new ObjectMediaStore(s3, config as Extract<typeof config, { kind: 'object' }>);
	await workerStore.put(ref, new TextEncoder().encode('REMOTE-INSTRUMENTAL'));

	// it landed under the shared, prefixed key — the SAME key the core resolves
	expect([...s3.store.keys()]).toEqual(['encore/stems/m1-instrumental.wav']);

	// CORE reads the worker's output back (this is what the /media proxy / readiness check does)
	expect(await coreStore.exists(ref)).toBe(true);
	expect(await new Response(await coreStore.get(ref)).text()).toBe('REMOTE-INSTRUMENTAL');
	// and the TV gets a presigned direct URL to it (bytes never transit the core)
	expect(coreStore.url(ref)).toBe('https://s3.fake/encore/stems/m1-instrumental.wav?X-Expires=3600');
});
