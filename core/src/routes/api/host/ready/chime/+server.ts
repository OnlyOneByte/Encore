// POST /api/host/ready/chime -> Ready for tonight's test sound, a 1 s chime on the room's TV only. Host only, and
// never over a song. The TV answers with `tv:audio`, which the Sound row reads. See docs/SERVER.md#ready-for-tonight.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';

export const POST: RequestHandler = async ({ cookies }) => {
	if (!can({ host: isHost(cookies) }, 'ready:check'))
		return json({ error: 'only the host can check the room' }, { status: 403 });
	const sent = getApp().screens?.chime() ?? 'no-tv';
	if (sent === 'no-tv') return json({ error: 'No TV is open', reason: 'no-tv' }, { status: 409 });
	if (sent === 'mid-song') return json({ error: 'Not over a song', reason: 'mid-song' }, { status: 409 });
	return json({ sent: true });
};
