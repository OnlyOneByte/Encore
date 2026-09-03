// PUT /api/settings/room — update THIS room's own policy (pacing, quality ceiling).
//
// Split from the global endpoint so a room write can never accidentally change deployment-wide
// separator policy: global answers "what can this deployment do", room "how does this party run".
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';
import type { RoomSettings } from '@encore/shared';

export const PUT: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) return json({ error: 'join first' }, { status: 401 });

	let body: Partial<RoomSettings>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	app.settings.setRoom(body);
	const settings = app.settings.getEffective();
	app.publish({ type: 'settings:changed', settings });
	return json(settings);
};
