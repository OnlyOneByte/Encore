// GET /api/host -> { host }. POST { key } swaps the host key for an `encore_host` session. DELETE signs out every host phone. See docs/SERVER.md#the-host-key.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { HOST_COOKIE, HOST_SESSION_MS } from '$lib/server/host-key';
import { isHost } from '$lib/server/host-gate';
import { publicOriginIsHttps } from '$lib/server/public-origin';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';

export const GET: RequestHandler = async ({ cookies }) => json({ host: isHost(cookies) });

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	const app = getApp();
	const key = requiredString(await readJsonBody(request), 'key');
	if (!key) return json({ error: 'key required' }, { status: 400 });
	// No per-address lockout: it could not slow guessing without locking out a host behind a guest's NAT.
	if (!app.hostKey.matches(key)) return json({ error: 'that is not the host key' }, { status: 403 });
	// Always a fresh token, so a cookie planted from another port on this host is never promoted.
	cookies.set(HOST_COOKIE, app.hostKey.open(app.now()), {
		path: '/',
		httpOnly: true,
		// Strict: no other site can make a request that carries it. The /host page is same-site, so the swap still lands.
		sameSite: 'strict',
		secure: publicOriginIsHttps(request, url),
		maxAge: HOST_SESSION_MS / 1000
	});
	return json({ host: true });
};

export const DELETE: RequestHandler = async ({ cookies }) => {
	if (!isHost(cookies)) return json({ error: 'only the host can do this' }, { status: 403 });
	getApp().hostKey.revokeAll();
	cookies.delete(HOST_COOKIE, { path: '/' });
	return json({ host: false });
};
