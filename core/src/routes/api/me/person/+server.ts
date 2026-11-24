// POST   /api/me/person — Keep me: keep tonight's singer on this phone.
// DELETE /api/me/person — Delete me: the person, every phone and every past night. See docs/SERVER.md#kept-people.
// Both answer the You tab's { kept, canKeep, otherPhones }.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { setSessionCookie } from '$lib/server/singers/session-cookie';
import {
	clearDeviceCookie,
	forgetPerson,
	keepSinger,
	keepState,
	keptCaller,
	readDevice,
	setDeviceCookie
} from '$lib/server/people/keep';

export const POST: RequestHandler = async ({ cookies, request, url }) => {
	const app = getApp();
	const me = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!me) return json({ error: 'join first' }, { status: 401 });
	if (!keepState(me, readDevice(app, cookies, { request, url }), app).canKeep) {
		return json(
			{ error: me.lastSungAt == null ? 'Sing a song first.' : 'This phone is kept already.' },
			{ status: 409 }
		);
	}
	const kept = keepSinger(app, me);
	setDeviceCookie(cookies, kept.deviceToken, { request, url });
	setSessionCookie(cookies, kept.singerToken, request, url);
	return json({ kept: true, canKeep: false, otherPhones: 0 });
};

export const DELETE: RequestHandler = async ({ cookies, request, url }) => {
	const app = getApp();
	const caller = keptCaller(app, cookies, { request, url });
	if (!caller) return json({ error: 'This phone is not kept.' }, { status: 401 });
	forgetPerson(app, caller.device.person.id, caller.me.id);
	clearDeviceCookie(cookies, { request, url });
	// Not offered again on this page: they just said no.
	return json({ kept: false, canKeep: false, otherPhones: 0 });
};
