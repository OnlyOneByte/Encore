// POST /api/host/tonight -> the host's "Show the night": the room's recap plays on the TV. Host only, and only between
// songs. See docs/SERVER.md#tonight.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { tonightFor } from '$lib/server/nights/service';

export const POST: RequestHandler = async ({ cookies }) => {
	if (!can({ host: isHost(cookies) }, 'night:show'))
		return json({ error: 'only the host can show the night' }, { status: 403 });
	const app = getApp();
	// Never over a song or ahead of one waiting: the room is watching the stage then.
	if (app.state.playback.currentEntryId || app.state.entries.some((e) => e.status !== 'done'))
		return json({ error: 'Show the night once the queue is empty', reason: 'busy' }, { status: 409 });
	const tonight = tonightFor(app);
	if (!tonight) return json({ error: 'No songs tonight yet', reason: 'empty' }, { status: 404 });
	app.publishTv({ type: 'tv:tonight', tonight });
	return json({ shown: true });
};
