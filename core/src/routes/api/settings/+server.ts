// GET /api/settings — both scopes, as the clients render them. PUT /api/settings updates GLOBAL (deployment separator + process policy); PUT /api/settings/room updates THIS ROOM (pacing, downward-only quality ceiling). A write broadcasts `settings:changed` with the combined payload, so a client never merges two events to know the effective state. Only the host may write either scope; the shared normalizers then degrade a partial or spoofed body to valid per-field values rather than persisting garbage.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { requireJsonType } from '$lib/server/http/json-body';
import type { GlobalSettings } from '$lib/contract';

export const GET: RequestHandler = async () => {
	const app = getApp();
	return json(app.settings.getEffective(app.activeRoomId));
};

export const PUT: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	if (!can({ host: isHost(cookies) }, 'settings:write-global'))
		return json({ error: 'only the host can change these' }, { status: 403 });
	requireJsonType(request);

	let body: Partial<GlobalSettings>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	// setGlobal re-normalizes over current values, so a partial body is a valid patch and an invalid engine/model pairing falls back rather than persisting.
	app.settings.setGlobal(body);
	const settings = app.settings.getEffective(app.activeRoomId);
	app.publish({ type: 'settings:changed', settings });
	return json(settings);
};
