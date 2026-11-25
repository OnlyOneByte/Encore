// POST /api/lyrics-edit/offset — { mediaId, offsetMs } -> the host's whole-song nudge, live on the TV with no
// re-time. Host only. See docs/SERVER.md#lyrics-fixes.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';
import { requestLyricsOffset } from '$lib/server/jobs/lyrics-edit';
import { refusal, refuseNonHost } from '../respond';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const denied = refuseNonHost(cookies);
	if (denied) return denied;
	const app = getApp();
	const body = await readJsonBody(request);
	const mediaId = requiredString(body, 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	if (typeof body.offsetMs !== 'number') return json({ error: 'offsetMs required' }, { status: 400 });

	const offsetMs = requestLyricsOffset(mediaId, body.offsetMs, app);
	if (typeof offsetMs === 'string') return refusal(offsetMs);
	const m = app.mediaById.get(mediaId);
	if (m) app.media.upsert(m);
	// The TV reads the nudge off its catalog, which a sync replaces.
	app.syncRoom?.();
	return json({ offsetMs });
};
