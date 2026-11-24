// The YOU scope's load: `me` and what Keep me offers. The controls here patch `/api/me` and `/api/me/person`, so no
// settings object, no join address and no worker catalogue is serialised into this page. See $lib/server/settings-gate
// for the gate itself and for why each scope route loads for itself rather than through a `+layout.server.ts`.
import type { PageServerLoad } from './$types';
import { getApp } from '$lib/server/app';
import { settingsSinger } from '$lib/server/settings-gate';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { keepState, readDevice } from '$lib/server/people/keep';

export const load: PageServerLoad = (event) => {
	const me = settingsSinger(event);
	const app = getApp();
	const stored = app.singers.bySessionToken(event.cookies.get(SESSION_COOKIE))!;
	const device = readDevice(app, event.cookies, event);
	// Opening the You tab on a kept phone counts as using it.
	if (device && stored.personId === device.person.id) app.people.touch(device.deviceId, app.now());
	return { me, keep: keepState(stored, device, app) };
};
