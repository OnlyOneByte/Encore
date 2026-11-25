// PUT    /api/me/songs/:mediaId — save a song in the library to your songs.
// DELETE /api/me/songs/:mediaId — unsave it. The song comes from the catalog, never from the body.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { historyOwner } from '$lib/server/nights/service';

export const PUT: RequestHandler = async ({ cookies, request, url, params }) => {
	const app = getApp();
	const caller = historyOwner(app, cookies, { request, url });
	if (!caller) return json({ error: 'join first' }, { status: 401 });
	const media = app.mediaById.get(params.mediaId ?? '');
	if (!media) return json({ error: 'no such song' }, { status: 404 });
	const saved = app.savedSongs.save(caller.owner, media, app.now());
	return json({ saved: { id: saved.id, savedAt: saved.savedAt } });
};

export const DELETE: RequestHandler = async ({ cookies, request, url, params }) => {
	const app = getApp();
	const caller = historyOwner(app, cookies, { request, url });
	if (!caller) return json({ error: 'join first' }, { status: 401 });
	const media = app.mediaById.get(params.mediaId ?? '');
	if (!media || !app.savedSongs.remove(caller.owner, media))
		return json({ error: 'not in your songs' }, { status: 404 });
	return json({ saved: null });
};
