// GET    /api/me/songs — Your songs: what you sang and saved, in the key you last finished it in.
// DELETE /api/me/songs — Forget my songs: every save of yours. Always your own: see docs/SERVER.md#your-songs.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { historyOwner } from '$lib/server/nights/service';
import { yourSongs } from '$lib/server/songs/service';
import { keepState, readDevice } from '$lib/server/people/keep';

export const GET: RequestHandler = async ({ cookies, request, url }) => {
	const app = getApp();
	const caller = historyOwner(app, cookies, { request, url });
	if (!caller) return json({ error: 'join first' }, { status: 401 });
	// The catalog row rides along, so the Sing tab can draw a saved song it has not loaded yet with its real state.
	// Not while its delete is pending, the same rule as /api/search and /api/library.
	const songs = yourSongs(app, caller.owner).map((s) => ({
		...s,
		media: s.mediaId && !app.pendingDeletes.has(s.mediaId) ? (app.mediaById.get(s.mediaId) ?? null) : null
	}));
	const canKeep = keepState(caller.me, readDevice(app, cookies, { request, url }), app).canKeep;
	return json({ songs, canKeep });
};

export const DELETE: RequestHandler = async ({ cookies, request, url }) => {
	const app = getApp();
	const caller = historyOwner(app, cookies, { request, url });
	if (!caller) return json({ error: 'join first' }, { status: 401 });
	return json({ removed: app.savedSongs.removeAll(caller.owner) });
};
