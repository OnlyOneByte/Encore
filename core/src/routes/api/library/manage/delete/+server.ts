// POST /api/library/manage/delete — { mediaId } -> the song leaves Library now and its files go when the Undo window closes. A kept song must be un-kept first, and a song in tonight's queue waits for its turn. Host only. See docs/SERVER.md#managing-the-library.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';
import { requestDelete } from '$lib/server/media/library-manage';
import { DELETE_UNDO_MS } from '$lib/contract';

const REFUSED = {
	unknown: { status: 404, body: { error: 'unknown media' } },
	queued: {
		status: 409,
		body: { error: "it's in tonight's queue; delete it after its turn", reason: 'queued' }
	},
	kept: { status: 409, body: { error: 'this song is kept; turn Keep off first', reason: 'kept' } }
} as const;

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!can({ host: isHost(cookies) }, 'media:delete'))
		return json({ error: 'only the host can delete songs' }, { status: 403 });
	const app = getApp();
	const mediaId = requiredString(await readJsonBody(request), 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	const result = await requestDelete(app, mediaId);
	if ('refused' in result) return json(REFUSED[result.refused].body, { status: REFUSED[result.refused].status });

	// Phones re-read Library on `canceled`, so the song leaves every screen now; Undo sends `ready` back.
	app.publish({ type: 'media:status', mediaId, status: 'canceled', pct: 0 });
	// A library-folder file is never deleted, only Encore's copy of the karaoke.
	return json({ pending: true, undoMs: DELETE_UNDO_MS, libraryFile: result.media.source === 'local' });
};
