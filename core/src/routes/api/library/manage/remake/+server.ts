// POST /api/library/manage/remake — { mediaId, what?: 'sound' | 'lyrics' } -> make the song's sound or lyrics again; the old version plays until the new is in. Host only. See docs/SERVER.md#managing-the-library.
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
	const body = await readJsonBody(request);
	const mediaId = requiredString(body, 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	const what = body.what ?? 'sound';
	if (what !== 'sound' && what !== 'lyrics')
		return json({ error: "what must be 'sound' or 'lyrics'" }, { status: 400 });
	const m = librarySong(app, mediaId);
	if (!m) return json({ error: 'unknown media' }, { status: 404 });
	// The aligner times words against the vocals stem; a song with none has nothing to time them on.
	if (what === 'lyrics' && !m.vocalsRef)
		return json({ error: 'this song has no vocals to time lyrics against' }, { status: 409 });

	const job = requestRemake(
		m,
		{ jobs: app.jobs, now: () => app.now() },
		what === 'sound' ? 'stems-remake' : 'align-remake'
	);
	app.workerHub.dispatch();
	// "After its turn": the sheet says so rather than leaving the host to wonder why nothing moved.
	const afterTurn = waitsForTurn(job, app.state.entries, app.state.playback.currentEntryId);
	return json({ ok: true, afterTurn });
};
