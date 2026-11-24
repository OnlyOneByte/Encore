// POST /api/lyrics-edit/undo — { mediaId, rev } -> put back the song's previous lyrics state: words and pick.
// Host only. See docs/SERVER.md#lyrics-fixes.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';
import { dropRestored, newestKept, requestLyricsUndo } from '$lib/server/jobs/lyrics-edit';
import { finish, refusal, refuseNonHost } from '../respond';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const denied = refuseNonHost(cookies);
	if (denied) return denied;
	const app = getApp();
	const body = await readJsonBody(request);
	const mediaId = requiredString(body, 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	if (typeof body.rev !== 'number') return json({ error: 'rev required' }, { status: 400 });

	const previous = await newestKept(mediaId);
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	const result = requestLyricsUndo(mediaId, body.rev, previous, app, singer?.id);
	if (typeof result === 'string') return refusal(result);
	// Same tick as the change, so no other change's history write can land between them.
	const dropped = dropRestored(mediaId, previous!);
	const response = await finish(app, mediaId, result);
	await dropped;
	return response;
};
