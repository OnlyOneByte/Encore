// POST /api/delete-media — { mediaId } -> hard-delete a song from the library ENTIRELY: cancels any in-flight process, removes every queue entry (skipping to the next singer if it was playing), unlinks the sidecar FIRST then audio + derived, drops the index row + tags, and broadcasts. Order is enforced in deleteMediaEntirely; this route is the thin HTTP seam beside /api/process that the admin dashboard calls.
// Host only (docs/SERVER.md#the-host-key).
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp, deleteSongNow } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();

	if (!can({ host: isHost(cookies) }, 'media:delete'))
		return json({ error: 'only the host can delete songs' }, { status: 403 });
	// The host need not have joined; the delete itself does not depend on who asked.
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));

	const mediaId = requiredString(await readJsonBody(request), 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });

	const result = deleteSongNow(app, mediaId, singer?.id);

	// Unknown media: nothing was deleted. 404 so the dashboard can tell "already gone" from "done".
	if (!result.deleted) return json({ error: 'unknown media' }, { status: 404 });

	return json({
		deleted: true,
		wasPlaying: result.wasPlaying,
		removedEntries: result.removedEntries
	});
};
