// A route rather than an overlay, because what it changes outlives the moment. Loading server-side is
// the point: first paint shows persisted values, and a default flashed for a frame here reads as "my
// choice was lost" rather than "still loading".
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';

export const load: PageServerLoad = async ({ cookies }) => {
	const app = getApp();

	// Same bar as the write endpoints: without a join every change here would 401.
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) redirect(303, '/join?next=/settings');

	return { settings: app.settings.getEffective() };
};
