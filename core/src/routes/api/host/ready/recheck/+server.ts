// POST /api/host/ready/recheck -> Check again: every connected karaoke maker runs its lyrics check now. Host only,
// at most once every 5 s. The page then reads GET /api/host/ready again. See docs/SERVER.md#ready-for-tonight.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { recheck } from '$lib/server/ready';

export const POST: RequestHandler = async ({ cookies }) => {
	if (!can({ host: isHost(cookies) }, 'ready:check'))
		return json({ error: 'only the host can check the room' }, { status: 403 });
	if (!recheck(getApp())) return json({ error: 'checked a moment ago', reason: 'too-soon' }, { status: 429 });
	return json({ asked: true });
};
