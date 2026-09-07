// A route rather than an overlay, because what it changes outlives the moment. Loading server-side is
// the point: first paint shows persisted values, and a default flashed for a frame here reads as "my
// choice was lost" rather than "still loading".
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';
import { fallbackJoinOrigin, publicOriginIsHttps } from '$server/public-origin';

/**
 * The three scopes, resolved server-side so the FIRST paint is already on the right tab — a deep link
 * from the header's name button (`?tab=you`) must not render Party for a frame and then swap.
 *
 * `party` is the default for a bare `/settings`, which is what the gear opens. The room is what you
 * change mid-song; the server's splitter and the lyrics reader are set once and then left alone.
 */
const TAB_IDS = ['you', 'party', 'server'] as const;
type TabId = (typeof TAB_IDS)[number];
const DEFAULT_TAB: TabId = 'party';

export const load: PageServerLoad = async ({ cookies, request, url }) => {
	const app = getApp();

	// Same bar as the write endpoints: without a join every change here would 401.
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) {
		// Carry the tab through the join gate, or a guest sent here to fix their name lands on Party.
		const next = encodeURIComponent(`/settings${url.search}`);
		redirect(303, `/join?next=${next}`);
	}

	// Never hand the session token to the page. It is the singer's identity, and the page data is
	// serialised into the HTML — the same projection every /api route makes for the same reason.
	const { sessionToken: _t, ...me } = singer;

	const requested = url.searchParams.get('tab');
	const tab: TabId = (TAB_IDS as readonly string[]).includes(requested ?? '') ? (requested as TabId) : DEFAULT_TAB;

	return {
		me,
		tab,
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
