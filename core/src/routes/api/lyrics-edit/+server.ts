// POST /api/lyrics-edit — { mediaId, rev, lines: {text}[] } -> the host's corrected words, re-timed by the worker.
// Host only. See docs/SERVER.md#lyrics-fixes.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';
import { parseEditLines, requestLyricsEdit } from '$lib/server/jobs/lyrics-edit';
import { finish, refusal, refuseNonHost } from './respond';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const denied = refuseNonHost(cookies);
	if (denied) return denied;
	const app = getApp();
	const body = await readJsonBody(request);
	const mediaId = requiredString(body, 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	if (typeof body.rev !== 'number') return json({ error: 'rev required' }, { status: 400 });
	const lines = parseEditLines(body.lines);
	if (typeof lines === 'string') return refusal(lines);

	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	const result = requestLyricsEdit(mediaId, { rev: body.rev, lines }, app, singer?.id);
	if (typeof result === 'string') return refusal(result);
	return finish(app, mediaId, result);
};
