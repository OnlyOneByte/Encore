// Serves a library/stems file through the configured MediaStore. This is a trust boundary: every ref
// goes through `safeMediaPath` before the store sees it.
//
// Byte ranges are mandatory, not a nicety: WebKit probes with `Range: bytes=0-1` and abandons the
// resource if the reply is a whole-body 200, so a range-less route means the TV never plays and emits
// no `error` event. The arithmetic lives in $lib/server/media/http-range.
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
	flac: 'audio/flac',
	opus: 'audio/ogg',
	json: 'application/json' // aligned-lyrics artifacts
};

// Library and stems files are immutable and addressed by name, so cache hard. An unmapped extension
// falls to application/octet-stream below, which the browser refuses to play.
const CACHE = 'public, max-age=86400';

/* One 404 for every way a ref can fail to resolve: a rejected path and a missing object are deliberately
   indistinguishable, so probing this route cannot enumerate what the store holds. */
const notFound = () => new Response('not found', { status: 404 });

export const GET: RequestHandler = async ({ params, request }) => {
	const ref = params.path ?? '';
	// Rejects traversal, absolute paths, NUL and .thumbs before the store sees the ref.
	if (!safeMediaPath(ref)) return notFound();

	const store = getApp().mediaStore;
	const ext = ref.split('.').pop()?.toLowerCase() ?? '';
	const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';

	// EVERY ref, of every store kind, is served same-origin through this route, so a store that answers
	// neither `size` nor `getRange` gets one un-seekable full-body 200 and will not play on WebKit. Both
	// shipped stores answer both; this is a floor for a future one. Serving media cross-origin instead
	// would taint MediaElementAudioSourceNode and need bucket CORS — see docs/arch/01-media.md.
	if (typeof store.size !== 'function' || typeof store.getRange !== 'function') {
		const stream = await store.get(ref);
		if (!stream) return notFound();
		return new Response(stream, { headers: { 'content-type': type, 'cache-control': CACHE } });
	}

	const size = await store.size(ref);
	if (size === null) return notFound();

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
		if (!body) return notFound();
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

	// Full response, but through getRange so the body is a Blob the runtime can set `Content-Length` on;
	// `accept-ranges` on a 200 is what invites the element to seek. An empty file has no range to slice.
	const body = size > 0 ? await store.getRange(ref, 0, size - 1) : await store.get(ref);
	if (!body) return notFound();
	return new Response(body, {
		headers: {
			'content-type': type,
			'accept-ranges': 'bytes',
			'cache-control': CACHE
		}
	});
};
