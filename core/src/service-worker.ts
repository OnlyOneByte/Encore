/// <reference types="@sveltejs/kit" />
// App-shell precache SW: cache-first for hashed build assets, network-first for navigations
// (fresh UI online, cached shell offline). SvelteKit's $service-worker gives the exact asset list.

import { build, files, version } from '$service-worker';
// The decisions live in a plain module so they can be unit-tested: nothing in THIS file can be, because
// `$service-worker` is a virtual module that exists only inside a build.
import { isCacheable, isPassThrough, isStream } from '$lib/sw-policy';

const CACHE = `encore-cache-${version}`;
const PRECACHE = [...build, ...files];

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);
	const facts = {
		method: request.method,
		pathname: url.pathname,
		destination: request.destination,
		hasRange: request.headers.has('range')
	};
	// A non-GET, the realtime socket, or the API: nothing here to serve from a cache.
	if (isPassThrough(facts)) return;

	/* STREAMS ARE NOT DOCUMENTS, and the catch-all below is written for documents.
	   `/media/…` is neither `/ws` nor `/api`, so an instrumental and the backing video used to fall straight
	   into it, on the machine with the least RAM in the room:

	     1. `res.clone()` TEES A STREAMING BODY. The tee's buffer grows to hold whatever the reader has not
	        consumed, so a minute-long instrumental is buffered in the TV's memory for no one.
	     2. `cache.put` REJECTS on a 206, and the rejection was unhandled. `media/[...path]` implements real
	        range support precisely because WebKit probes a media resource with `Range: bytes=0-1` and
	        abandons it silently on a 200 (see `lib/server/media/http-range.ts`) — so every playback produced
	        at least one unhandled TypeError in the one console an operator debugging a party would look at.
	     3. A full 200 was written whole to the SD card beside the precached app shell.

	   Gated on `request.destination` rather than the path, because the SAME prefix serves the one thing under
	   `/media` worth caching: `LyricsOverlay` fetches the lyrics document from `/media/<lyricsRef>`, which is
	   small JSON with destination `empty`. Range-bearing requests are excluded whatever their destination —
	   a 206 can never be cached. */
	const isPrecached = PRECACHE.includes(url.pathname);
	if (isPrecached) {
		event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
		return;
	}
	if (isStream(facts)) return; // straight to the network, untouched and untee'd
	event.respondWith(
		fetch(request)
			.then((res) => {
				// Only a complete, successful response is cacheable: `cache.put` rejects a 206 and an opaque
				// cross-origin response, and caching a 4xx/5xx would serve the error back while offline.
				if (isCacheable(res)) {
					const copy = res.clone();
					void caches
						.open(CACHE)
						.then((c) => c.put(request, copy))
						.catch(() => {
							/* a full disk or an uncacheable response must not become an unhandled rejection */
						});
				}
				return res;
			})
			.catch(() => caches.match(request).then((hit) => hit ?? caches.match('/')) as Promise<Response>)
	);
});
