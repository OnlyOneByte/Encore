// GET  /api/settings        — both scopes, as the clients render them.
// PUT  /api/settings        — update GLOBAL (deployment separator + cook policy).
// PUT  /api/settings/room   — update THIS ROOM (pacing, downward-only quality ceiling).
//
// A write broadcasts `settings:changed` with the combined payload, so a client never merges two
// events to know the effective state. A joined singer may write either scope (same bar as queueing);
// the shared normalizers are the gate, degrading a partial or spoofed body to valid per-field values
// rather than persisting garbage or naming an engine no worker can run.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';
import type { GlobalSettings } from '@encore/shared';

export const GET: RequestHandler = async () => {
	return json(getApp().settings.getEffective());
};

export const PUT: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) return json({ error: 'join first' }, { status: 401 });

	let body: Partial<GlobalSettings>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	// setGlobal re-normalizes over current values, so a partial body is a valid patch and an invalid
	// engine/model pairing falls back rather than persisting.
	app.settings.setGlobal(body);
	const settings = app.settings.getEffective();
	app.publish({ type: 'settings:changed', settings });
	return json(settings);
};
