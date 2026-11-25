// POST /api/library/manage/remake — { mediaId } -> make the song's sound again; the old stems play until the new are in. Host only. See docs/SERVER.md#managing-the-library.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';
import { librarySong } from '$lib/server/media/library-manage';
import { requestRemake } from '$lib/server/jobs/process';
import { waitsForTurn } from '$lib/server/jobs/dispatch';

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!can({ host: isHost(cookies) }, 'media:edit'))
		return json({ error: 'only the host can make a song again' }, { status: 403 });
	const app = getApp();
	const mediaId = requiredString(await readJsonBody(request), 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	const m = librarySong(app, mediaId);
	if (!m) return json({ error: 'unknown media' }, { status: 404 });

	const job = requestRemake(m, { jobs: app.jobs, now: () => app.now() });
	app.workerHub.dispatch();
	// "After its turn": the sheet says so rather than leaving the host to wonder why nothing moved.
	const afterTurn = waitsForTurn(job, app.state.entries, app.state.playback.currentEntryId);
	return json({ ok: true, afterTurn });
};
