// GET /api/host/ready -> Ready for tonight's six rows (proposal 39). Host only, and computed from live state each
// time. See docs/SERVER.md#ready-for-tonight.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readyFacts } from '$lib/server/ready';
import { readyRows } from '$lib/ready';

export const GET: RequestHandler = async ({ cookies }) => {
	if (!can({ host: isHost(cookies) }, 'ready:check'))
		return json({ error: 'only the host can check the room' }, { status: 403 });
	return json({ rows: readyRows(await readyFacts(getApp())) });
};
