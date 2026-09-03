// Settings has its own route rather than an overlay. What these controls change — which separator
// every future cook uses, how long the TV holds the next-up card — outlives the moment, so it should
// be somewhere you can navigate to, deep-link, and reload, instead of a layer that evaporates.
//
// Loading server-side is the point of being a page: first paint shows the persisted values. Fetching
// after mount would render defaults for a frame, and on this screen a wrong default does not read as
// "still loading", it reads as "my choice was lost".
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
