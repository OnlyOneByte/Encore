// The host check every host-only route and page runs. See docs/SERVER.md#the-host-key.
import { redirect, type Cookies } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { HOST_COOKIE } from '$lib/server/host-key';

export function isHost(cookies: Pick<Cookies, 'get'>): boolean {
	const app = getApp();
	return app.hostKey.isHost(cookies.get(HOST_COOKIE), app.now());
}

/** For a host-only PAGE load: anyone else goes to /host, which says how to unlock, and comes back after. */
export function requireHost({ cookies, url }: { cookies: Pick<Cookies, 'get'>; url: URL }): void {
	if (!isHost(cookies)) redirect(303, `/host?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
}
