// GET    /api/me/songs — Your songs: what you sang and saved, in the key you last finished it in.
// DELETE /api/me/songs — Forget my songs: every save of yours. Always your own: see docs/SERVER.md#your-songs.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { historyOwner } from '$lib/server/nights/service';
import { yourSongs } from '$lib/server/songs/service';

export const GET: RequestHandler = async ({ cookies, request, url }) => {
	const app = getApp();
	const caller = historyOwner(app, cookies, { request, url });
	if (!caller) return json({ error: 'join first' }, { status: 401 });
	return json({ songs: yourSongs(app, caller.owner) });
};

export const DELETE: RequestHandler = async ({ cookies, request, url }) => {
	const app = getApp();
	const caller = historyOwner(app, cookies, { request, url });
	if (!caller) return json({ error: 'join first' }, { status: 401 });
	return json({ removed: app.savedSongs.removeAll(caller.owner) });
};
