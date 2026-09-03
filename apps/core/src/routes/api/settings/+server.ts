// GET  /api/settings — the room's current separator settings (B-8).
// PUT  /api/settings — update them, then broadcast `settings:changed` to the whole room.
//
// Room-level, not per-phone: the engine/model choice governs cooks EVERYONE shares. A joined singer
// may change it (same bar as queueing — the cookie is already there); an un-joined browser may not.
// normalizeRoomSettings() is the gate: a partial or spoofed payload degrades to valid values
// per-field rather than persisting garbage or reaching a worker that would fail mid-cook.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';
import type { RoomSettings } from '@encore/shared';

export const GET: RequestHandler = async () => {
	return json(getApp().settings.get());
};

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

	// set() re-normalizes over the current settings, so a partial body (e.g. just `enqueueUpgrade`)
	// is a valid patch and an invalid engine/model pairing falls back rather than persisting.
	const next = app.settings.set(body);
	app.publish({ type: 'settings:changed', settings: next });
	return json(next);
};
