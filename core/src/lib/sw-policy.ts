// What the service worker does with a request, as PURE FUNCTIONS over the parts it reads.
//
// WHY THIS IS NOT INLINE IN `service-worker.ts`. That module imports `$service-worker`, a SvelteKit
// virtual module that only exists inside a build, so nothing in it can be unit-tested — and the defect
// this file exists to prevent was invisible for exactly that reason: the fetch handler's catch-all teed
// every streaming byte the television played and let `cache.put` reject unhandled on every 206.
//
// The rules are small enough to read in one pass, and each one is here because leaving it out cost
// something measurable. See the comments on each.

/** The parts of a `Request` these decisions actually read. A plain shape, so a test needs no `Request`. */
export interface RequestFacts {
	method: string;
	/** `URL.pathname`. */
	pathname: string;
	/** `Request.destination` — `'audio'`/`'video'` for a media element's own load, `''` for `fetch()`. */
	destination: string;
	/** Whether the request carries a `Range` header. */
	hasRange: boolean;
}

/** The parts of a `Response` the caching decision reads. */
export interface ResponseFacts {
	ok: boolean;
	status: number;
}

/**
 * Requests the worker must not touch at all.
 *
 * `/ws` and `/api` are live: a socket upgrade and a queue mutation have nothing to serve from a cache,
 * and intercepting them only adds a frame to the critical path.
 */
export function isPassThrough(r: RequestFacts): boolean {
	if (r.method !== 'GET') return true;
	return r.pathname.startsWith('/ws') || r.pathname.startsWith('/api');
}

/**
 * A STREAM, which must reach the network untouched — not merely uncached.
 *
 * Gated on `destination`, never on the `/media` prefix, because the same prefix serves the one thing
 * under it worth caching: `LyricsOverlay` fetches the lyrics document from `/media/<lyricsRef>`, which is
 * small JSON whose destination is `''`.
 *
 * A range-bearing request is a stream whatever its destination, because a 206 can never be cached and
 * `media/[...path]` implements real range support on purpose — WebKit probes a media resource with
 * `Range: bytes=0-1` and abandons it SILENTLY if it gets a 200 (`lib/server/media/http-range.ts`).
 */
export function isStream(r: RequestFacts): boolean {
	return r.destination === 'audio' || r.destination === 'video' || r.hasRange;
}

/**
 * Whether a response may be written to the cache.
 *
 * Only a complete success: `cache.put` REJECTS on a 206 and on an opaque cross-origin response, and an
 * unhandled rejection there is one console error per media range probe. A cached 4xx/5xx would be served
 * back later as though it were the page.
 */
export function isCacheable(res: ResponseFacts): boolean {
	return res.ok && res.status === 200;
}
