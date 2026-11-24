// POST /api/library/manage/keep — { mediaId, keep } -> a kept song is never evicted by the disk cap. Host only. See docs/SERVER.md#managing-the-library.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';
import { librarySong, setKeep } from '$lib/server/media/library-manage';

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!can({ host: isHost(cookies) }, 'media:edit'))
		return json({ error: 'only the host can keep songs' }, { status: 403 });
	const app = getApp();
	const body = await readJsonBody(request);
	const mediaId = requiredString(body, 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	if (typeof body.keep !== 'boolean') return json({ error: 'keep must be true or false' }, { status: 400 });
	if (!librarySong(app, mediaId) || !(await setKeep(mediaId, body.keep)))
		return json({ error: 'unknown media' }, { status: 404 });
	return json({ ok: true, kept: body.keep });
};
