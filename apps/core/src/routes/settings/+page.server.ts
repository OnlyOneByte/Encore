// A route rather than an overlay, because what it changes outlives the moment. Loading server-side is
// the point: first paint shows persisted values, and a default flashed for a frame here reads as "my
// choice was lost" rather than "still loading".
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';
import { fallbackJoinOrigin, publicOriginIsHttps } from '$server/public-origin';

export const load: PageServerLoad = async ({ cookies, request, url }) => {
	const app = getApp();

	// Same bar as the write endpoints: without a join every change here would 401.
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) redirect(303, '/join?next=/settings');

	return {
		settings: app.settings.getEffective(),
		// What an empty join address resolves to, so the field can show its fallback rather than an empty
		// box the user has to guess at.
		joinOriginFallback: fallbackJoinOrigin(request, url),
		// How THIS phone reached the server. An https join address on a plain-http party is the one
		// mistake in that field worth warning about, and only the server knows the real scheme —
		// `location.protocol` in the browser cannot be trusted here for the same reason `url.protocol`
		// cannot on the server (see $server/public-origin).
		requestIsHttps: publicOriginIsHttps(request, url)
	};
};
