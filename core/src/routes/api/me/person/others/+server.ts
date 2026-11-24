// DELETE /api/me/person/others — sign out every other phone this person is kept on, and any copy of this one's
// cookie. See docs/SERVER.md#kept-people.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { keepState, keptCaller, rotateDevice, signOutOtherPhones } from '$lib/server/people/keep';

export const DELETE: RequestHandler = async ({ cookies, request, url }) => {
	const app = getApp();
	const caller = keptCaller(app, cookies, { request, url });
	if (!caller) return json({ error: 'This phone is not kept.' }, { status: 401 });
	signOutOtherPhones(app, caller.device, caller.me.id);
	rotateDevice(app, cookies, caller.device, { request, url });
	return json(keepState(caller.me, caller.device, app));
};
