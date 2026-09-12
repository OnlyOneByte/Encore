// GET /media/<ref> — the route serves HTTP byte ranges (206 + Content-Range) ONLY when the resolved
// MediaStore answers size()/getRange(). The object store used to answer neither, so this route
// took its degrade branch and returned a range-less full 200 — WebKit (Safari/iOS) then abandons the
// resource on its `Range: bytes=0-1` probe and the TV silently never plays. These tests drive the
// real GET handler against a real ObjectMediaStore (backed by an in-memory fake S3) and assert the
// actual status + Content-Range + partial bytes, so the object-store path is pinned to 206, not 200.
import { test, expect, afterEach } from 'bun:test';
import { GET } from '../../../../../../src/routes/media/[...path]/+server';
import { ObjectMediaStore, type S3Like } from '$lib/server/media/object-store';
import type { MediaStore } from '$lib/server/media/store';

const APP_KEY = Symbol.for('encore.app');

function fakeS3(): S3Like {
	const store = new Map<string, Blob>();
	return {
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
					return (store.get(key) ?? new Blob()).slice(start, end);
				}
			};
		}
	};
}

/** Install a minimal app exposing only the mediaStore the route reads via getApp(). */
function installStore(store: MediaStore) {
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = { mediaStore: store };
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function call(ref: string, range?: string) {
	const headers = new Headers();
	if (range) headers.set('range', range);
	return GET({ params: { path: ref }, request: new Request('http://x/media/' + ref, { headers }) } as never);
}

async function objectStoreWith(ref: string, bytes: string): Promise<MediaStore> {
	process.env.MEDIA_DIR = '/srv/encore/media'; // safeMediaPath needs a root; refs used here are safe
	const store = new ObjectMediaStore(fakeS3(), { prefix: 'encore/' });
	await store.put(ref, new TextEncoder().encode(bytes));
	return store;
}

test('object store: a Range request gets 206 + Content-Range + exactly the requested bytes', async () => {
	installStore(await objectStoreWith('stems/m1-instrumental.flac', '0123456789'));
	const res = await call('stems/m1-instrumental.flac', 'bytes=0-1'); // the WebKit probe
	expect(res.status).toBe(206);
	expect(res.headers.get('content-range')).toBe('bytes 0-1/10');
	expect(res.headers.get('accept-ranges')).toBe('bytes');
	expect(await res.text()).toBe('01'); // TWO bytes — an exclusive end would drop the second
});

test('object store: a mid-file range keeps both endpoints (inclusive)', async () => {
	installStore(await objectStoreWith('stems/m1-instrumental.flac', '0123456789'));
	const res = await call('stems/m1-instrumental.flac', 'bytes=3-5');
	expect(res.status).toBe(206);
	expect(res.headers.get('content-range')).toBe('bytes 3-5/10');
	expect(await res.text()).toBe('345');
});

test('object store: a range-less GET is a 200 that ADVERTISES ranges (accept-ranges)', async () => {
	installStore(await objectStoreWith('stems/m1-instrumental.flac', '0123456789'));
	const res = await call('stems/m1-instrumental.flac');
	expect(res.status).toBe(200);
	// advertising bytes on the 200 is what invites the element to seek at all — the original bug was
	// its ABSENCE on the object-store path
	expect(res.headers.get('accept-ranges')).toBe('bytes');
	expect(await res.text()).toBe('0123456789');
});

test('DEGRADE floor: a store missing size()/getRange() serves a range-less 200 (no accept-ranges)', async () => {
	// A future/partial store that omits the range capability keeps the old behaviour — this is the
	// branch the comment at +server.ts documents, and the exact state that made WebKit silent.
	const bare: MediaStore = {
		kind: 'local',
		async exists() {
			return true;
		},
		async get() {
			return new Blob([new TextEncoder().encode('0123456789')]).stream();
		},
		async put() {},
		url() {
			return null;
		}
	};
	installStore(bare);
	const res = await call('stems/x.flac', 'bytes=0-1');
	expect(res.status).toBe(200); // NOT 206 — it cannot slice
	expect(res.headers.get('accept-ranges')).toBeNull(); // and it does NOT advertise ranges
	expect(await res.text()).toBe('0123456789');
});
