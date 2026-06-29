/// <reference types="@sveltejs/kit" />
// App-shell precache service worker. SvelteKit exposes the exact build asset list via
// $service-worker, so warm loads serve instantly and the shell works offline.
// Network-first for navigations (fresh UI when online), cache-first for hashed build assets.

import { build, files, version } from '$service-worker';

const CACHE = `encore-cache-${version}`;
const PRECACHE = [...build, ...files]; // hashed JS/CSS + static/ assets

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
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
		// cache-first for immutable hashed assets
		event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
		return;
	}
	// network-first for navigations/pages; fall back to cached shell offline
	event.respondWith(
		fetch(request)
			.then((res) => {
				const copy = res.clone();
				caches.open(CACHE).then((c) => c.put(request, copy));
				return res;
			})
			.catch(() => caches.match(request).then((hit) => hit ?? caches.match('/')) as Promise<Response>)
	);
});
