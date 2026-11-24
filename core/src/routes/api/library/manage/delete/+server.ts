// POST /api/library/manage/delete — { mediaId } -> the song leaves Library now and its files go when the Undo window closes. A kept song must be un-kept first. Host only. See docs/SERVER.md#managing-the-library.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';
import { readSidecar } from '$lib/server/media/sidecar';
import { DELETE_UNDO_MS } from '$lib/contract';

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!can({ host: isHost(cookies) }, 'media:delete'))
		return json({ error: 'only the host can delete songs' }, { status: 403 });
	const app = getApp();
	const mediaId = requiredString(await readJsonBody(request), 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	const m = app.mediaById.get(mediaId);
	if (!m) return json({ error: 'unknown media' }, { status: 404 });
	if ((await readSidecar(mediaId))?.library.keep)
		return json({ error: 'this song is kept; turn Keep off first', reason: 'kept' }, { status: 409 });

	app.pendingDeletes.schedule(mediaId);
	// A library-folder file is never deleted, only Encore's copy of the karaoke.
	return json({ pending: true, undoMs: DELETE_UNDO_MS, libraryFile: m.source === 'local' });
};
