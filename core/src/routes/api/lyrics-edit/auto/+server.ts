// POST /api/lyrics-edit/auto — { mediaId, rev } -> back to automatic lyrics: the host's words and pick are
// dropped (and kept for Undo). Host only. See docs/SERVER.md#lyrics-fixes.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';
import { requestLyricsAuto } from '$lib/server/jobs/lyrics-edit';
import { finish, refusal, refuseNonHost } from '../respond';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const denied = refuseNonHost(cookies);
	if (denied) return denied;
	const app = getApp();
	const body = await readJsonBody(request);
	const mediaId = requiredString(body, 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	if (typeof body.rev !== 'number') return json({ error: 'rev required' }, { status: 400 });

	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	const result = requestLyricsAuto(mediaId, body.rev, app, singer?.id);
	if (typeof result === 'string') return refusal(result);
	return finish(app, mediaId, result);
};
