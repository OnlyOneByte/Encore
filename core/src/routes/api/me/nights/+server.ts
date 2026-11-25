// GET    /api/me/nights?tz=<IANA> — your nights, newest first, whether new ones are kept, and your year in `tz`.
// PATCH  /api/me/nights — { recording: boolean }: "Don't keep my nights" off or on.
// DELETE /api/me/nights — Delete my history. Always your own: see docs/SERVER.md#your-night.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { historyOwner, yourYear } from '$lib/server/nights/service';
import { readJsonBody } from '$lib/server/http/json-body';

const subjectsOf = (owner: { singerId: string; personId: string | null }) =>
	owner.personId ? [owner.singerId, owner.personId] : [owner.singerId];

export const GET: RequestHandler = async ({ cookies, request, url }) => {
	const app = getApp();
	const caller = historyOwner(app, cookies, { request, url });
	if (!caller) return json({ error: 'join first' }, { status: 401 });
	return json({
		recording: app.nights.isRecording([caller.me.id, caller.me.personId]),
		nights: app.nights.nightsFor(caller.owner),
		// "Your year": this calendar year in the phone's zone (`?tz=`), else the core's own.
		year: yourYear(app, caller.owner, url.searchParams.get('tz'))
	});
};

export const PATCH: RequestHandler = async ({ cookies, request, url }) => {
	const app = getApp();
	const caller = historyOwner(app, cookies, { request, url });
	if (!caller) return json({ error: 'join first' }, { status: 401 });
	const { recording } = await readJsonBody(request);
	if (typeof recording !== 'boolean') return json({ error: 'recording must be true or false' }, { status: 400 });
	app.nights.setRecording(subjectsOf(caller.owner), recording, app.now());
	return json({ recording: app.nights.isRecording([caller.me.id, caller.me.personId]) });
};

export const DELETE: RequestHandler = async ({ cookies, request, url }) => {
	const app = getApp();
	const caller = historyOwner(app, cookies, { request, url });
	if (!caller) return json({ error: 'join first' }, { status: 401 });
	return json({ deleted: app.nights.deleteFor(caller.owner) });
};
