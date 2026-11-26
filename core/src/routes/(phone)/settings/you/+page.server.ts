// The YOU scope's load: `me`, what Keep me offers, and your own nights. The controls here patch `/api/me`,
// `/api/me/person` and `/api/me/nights`, so no settings object, no join address and no worker catalogue is serialised
// into this page. See $lib/server/settings-gate for the gate itself and for why each scope route loads for itself
// rather than through a `+layout.server.ts`.
import type { PageServerLoad } from './$types';
import { getApp } from '$lib/server/app';
import { settingsSinger } from '$lib/server/settings-gate';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { keepState, readDevice } from '$lib/server/people/keep';
import { historyOwner, yourYear } from '$lib/server/nights/service';
import { knownZone, zoneOrServer, ZONE_COOKIE } from '$lib/server/nights/year';

// shortcut: the server's zone, as on the story page.
const when = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

export const load: PageServerLoad = (event) => {
	const me = settingsSinger(event);
	const app = getApp();
	const stored = app.singers.bySessionToken(event.cookies.get(SESSION_COOKIE))!;
	const device = readDevice(app, event.cookies, event);
	// Opening the You tab on a kept phone counts as using it.
	if (device && stored.personId === device.person.id) app.people.touch(device.deviceId, app.now());
	// Your nights only: the owner is this phone's cookies, as GET /api/me/nights reads them.
	const caller = historyOwner(app, event.cookies, event)!;
	const zoneCookie = knownZone(event.cookies.get(ZONE_COOKIE));
	return {
		me,
		keep: keepState(stored, device, app),
		nights: {
			recording: app.nights.isRecording([caller.me.id, caller.me.personId]),
			// The same list GET /api/me/nights serves: sung songs only, newest first.
			list: app.nights
				.nightsFor(caller.owner)
				.map((n) => ({ id: n.id, when: when.format(n.startedAt), songs: n.songs })),
			// Your year in the phone's zone when it told us before (ZONE_COOKIE), else the core's; the page asks again
			// with `?tz=` only when `zone` is not the phone's, so a remembered zone renders once with nothing to swap.
			year: yourYear(app, caller.owner, zoneCookie),
			zone: zoneOrServer(zoneCookie)
		}
	};
};
