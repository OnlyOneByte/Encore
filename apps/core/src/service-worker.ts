/// <reference types="@sveltejs/kit" />
// App-shell precache SW: cache-first for hashed build assets, network-first for navigations
// (fresh UI online, cached shell offline). SvelteKit's $service-worker gives the exact asset list.

import { build, files, version } from '$service-worker';

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
	if (request.method !== 'GET') return;
	// never intercept the realtime socket or API
	const url = new URL(request.url);
	if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api')) return;

	const isPrecached = PRECACHE.includes(url.pathname);
	if (isPrecached) {
		event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
		return;
	}
	event.respondWith(
		fetch(request)
			.then((res) => {
				const copy = res.clone();
				void caches.open(CACHE).then((c) => c.put(request, copy));
				return res;
			})
			.catch(() => caches.match(request).then((hit) => hit ?? caches.match('/')) as Promise<Response>)
	);
});
