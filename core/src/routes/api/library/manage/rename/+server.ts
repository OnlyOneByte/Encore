// POST /api/library/manage/rename — { mediaId, title, artist } -> the host's name for a song, which no later parse or annotation overwrites. Host only. See docs/SERVER.md#managing-the-library.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';
import { NAME_MAX, renameSong } from '$lib/server/media/library-manage';

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!can({ host: isHost(cookies) }, 'media:edit'))
		return json({ error: 'only the host can rename songs' }, { status: 403 });
	const app = getApp();
	const body = await readJsonBody(request);
	const mediaId = requiredString(body, 'mediaId');
	const title = requiredString(body, 'title').trim();
	const artist = requiredString(body, 'artist').trim();
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	if (!title) return json({ error: 'a song needs a title' }, { status: 400 });
	if (title.length > NAME_MAX || artist.length > NAME_MAX)
		return json({ error: 'that name is too long' }, { status: 400 });
	const m = app.mediaById.get(mediaId);
	if (!m || app.pendingDeletes.has(mediaId)) return json({ error: 'unknown media' }, { status: 404 });

	await renameSong(m, { title, artist: artist || null }, (next) => app.media.upsert(next));
	// Every phone re-reads Library on a ready status, so the new name shows everywhere.
	app.publish({ type: 'media:status', mediaId, status: 'ready', pct: 100 });
	return json({ ok: true });
};
