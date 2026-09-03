// Settings is a route, not an overlay: what it changes (which separator every future cook uses, how
// long the TV holds the next-up card) outlives the moment, so it should be navigable, deep-linkable,
// and reloadable rather than a layer that evaporates.
//
// Loading server-side is the point of being a page: first paint shows the persisted values. Fetching
// after mount would show defaults for a frame, and here a wrong default reads as "my choice was
// lost", not "still loading".
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';

export const load: PageServerLoad = async ({ cookies }) => {
	const app = getApp();

	// The same bar the write endpoints enforce. Rendering the controls to someone who has not joined
	// would offer a screen where every change 401s, so send them to join and come back here after.
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) redirect(303, '/join?next=/settings');

	return { settings: app.settings.getEffective() };
};
