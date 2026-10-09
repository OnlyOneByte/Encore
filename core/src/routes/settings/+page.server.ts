// The ROOM scope's load. `settings` only: no control here reads the singer, the join address or the worker
// catalogue, so none of those is serialised into this page. See $lib/server/settings-gate for why each scope route
// loads for itself rather than through a `+layout.server.ts`.
import type { PageServerLoad } from './$types';
import { getApp } from '$lib/server/app';
import { settingsSinger } from '$lib/server/settings-gate';

export const load: PageServerLoad = (event) => {
	// FOR THE GATE, not for the value: `settingsSinger` throws the join redirect, and every settings write is a 401
	// without a session.
	settingsSinger(event);

	const app = getApp();
	return { settings: app.settings.getEffective(app.activeRoomId) };
};
