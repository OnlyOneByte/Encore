// The ROOM scope's load. `settings` only: no control here reads the singer, the join address or the worker
// catalogue, so none of those is serialised into this page. See $lib/server/settings-gate for why each scope route
// loads for itself rather than through a `+layout.server.ts`.
import type { PageServerLoad } from './$types';
import { getApp } from '$lib/server/app';
import { settingsLock } from '$lib/server/settings-gate';

export const load: PageServerLoad = (event) => {
	// Throws the join redirect for a visitor who is neither the host nor joined.
	const locked = settingsLock(event);

	const app = getApp();
	return { settings: app.settings.getEffective(app.activeRoomId), locked };
};
