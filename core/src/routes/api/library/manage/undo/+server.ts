// POST /api/library/manage/undo — { mediaId } -> cancels a pending library delete while its Undo window is open. Host only. See docs/SERVER.md#managing-the-library.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!can({ host: isHost(cookies) }, 'media:delete'))
		return json({ error: 'only the host can do this' }, { status: 403 });
	const app = getApp();
	const mediaId = requiredString(await readJsonBody(request), 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	if (!app.pendingDeletes.undo(mediaId)) return json({ error: 'too late; that song is gone' }, { status: 409 });
	// Phones that re-read Library during the window come back to it.
	app.publish({ type: 'media:status', mediaId, status: 'ready', pct: 100 });
	return json({ ok: true });
};
