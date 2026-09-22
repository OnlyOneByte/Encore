// GET /media/<sourceRef> — serve a library/stems file through the configured MediaStore (local
// volume or, when proxying an object store, streamed from S3/MinIO). The path-traversal guard
// (Finding #2) lives in safeMediaPath, enforced by the store's url()/get() at this trust boundary.
//
// This route answers HTTP BYTE RANGES. That is not a nicety: WebKit (Safari, and every browser on
// iOS) probes a media resource with `Range: bytes=0-1` and abandons it if the server replies `200`
// with the whole body, so a range-less route means the TV's `<video>` never plays at all — silently,
// with no `error` event to notice. It is also the only way seeking can work in ANY browser. The range
// arithmetic lives in $lib/server/media/http-range so it is tested without a server; see that file for the
// full write-up of how the failure hides.
import type { RequestHandler } from '@sveltejs/kit';
import { safeMediaPath } from '$lib/server/media/local-files';
import { parseRangeHeader, contentRange, unsatisfiedContentRange } from '$lib/server/media/http-range';
import { getApp } from '$lib/server/app';

const CONTENT_TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	webm: 'video/webm',
	m4a: 'audio/mp4',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	flac: 'audio/flac', // lossless instrumental (audio policy) — without this the browser gets
	// application/octet-stream and refuses to play it
	opus: 'audio/ogg',
	json: 'application/json' // aligned-lyrics artifacts
};

// library/stems files are immutable content addressed by name; cache hard
const CACHE = 'public, max-age=86400';

export const GET: RequestHandler = async ({ params, request }) => {
	const ref = params.path ?? '';
	// the guard rejects traversal / absolute / NUL /.thumbs before we hit the store
	if (!safeMediaPath(ref)) return new Response('not found', { status: 404 });

	const store = getApp().mediaStore;
	const ext = ref.split('.').pop()?.toLowerCase() ?? '';
	const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';

	// Fallback for a MediaStore that implements neither `size` nor `getRange`: one full-body 200 with
	// no `accept-ranges`, which means WebKit (Safari/iOS) will refuse to play — see media/http-range.ts.
	// Both shipped stores (local + object) answer these, so this is a floor for a future store, NOT the
	// object-store path: EVERY ref, of EVERY store kind, is served through this same-origin route
	// (TvPlayer hardcodes `/media/${ref}`, as does LyricsOverlay's artifact fetch), so the object store
	// MUST serve ranges here.
	//
	// ON THE RECORD — the presigned direct-to-S3 path was REMOVED, not overlooked. `MediaStore.url()`
	// (and `mediaProxyUrl`, `ObjectMediaStore`'s `presignExpiresIn`/`proxyUrls`, and `S3Like.presign`)
	// handed out a 1-hour presigned URL and had ZERO production callers — its only callers were its own
	// tests, which is why the absence stayed invisible to coverage. It is deleted rather than wired up
	// because wiring it would regress three things at once: (1) a cross-origin media element taints
	// `MediaElementAudioSourceNode`, so the deferred FFT visualizer work silently goes flat with no
	// error ("Audio-REACTIVE visualizers"); (2) LyricsOverlay `fetch`es its
	// artifacts from this origin and would need bucket CORS; (3) a presigned URL is a bearer credential
	// for a media file with a TTL nobody specified, and a song plus its queue wait can outlive an hour.
	// Re-adding a URL member is therefore a product decision about same-origin playback, not a store
	// detail — see docs/arch/01-media.md. The guard is
	// tests/guards/subsystem-media/store-members-have-production-callers.test.ts.
	if (typeof store.size !== 'function' || typeof store.getRange !== 'function') {
		const stream = await store.get(ref);
		if (!stream) return new Response('not found', { status: 404 });
		return new Response(stream, { headers: { 'content-type': type, 'cache-control': CACHE } });
	}

	const size = await store.size(ref);
	if (size === null) return new Response('not found', { status: 404 });

	const decision = parseRangeHeader(request.headers.get('range'), size);

	if (decision.kind === 'unsatisfiable') {
		// 416 MUST carry the real size, which is how a client that guessed wrong recovers in one retry.
		return new Response(null, {
			status: 416,
			headers: {
				'content-range': unsatisfiedContentRange(size),
				'accept-ranges': 'bytes',
				'content-type': type
			}
		});
	}

	if (decision.kind === 'partial') {
		const { start, end } = decision;
		const body = await store.getRange(ref, start, end);
		if (!body) return new Response('not found', { status: 404 });
		return new Response(body, {
			status: 206,
			headers: {
				'content-type': type,
				'content-range': contentRange(start, end, size),
				'accept-ranges': 'bytes',
				'cache-control': CACHE
			}
		});
	}

	// A full response, but served through getRange so the body is a Blob and the runtime can set
	// `Content-Length`. Advertising `bytes` on a 200 is what invites the element to seek at all, and the
	// length is how it learns the resource size without decoding to the end. An empty file has no range
	// to slice, so it falls back to the plain read.
	const body = size > 0 ? await store.getRange(ref, 0, size - 1) : await store.get(ref);
	if (!body) return new Response('not found', { status: 404 });
	return new Response(body, {
		headers: {
			'content-type': type,
			'accept-ranges': 'bytes',
			'cache-control': CACHE
		}
	});
};
