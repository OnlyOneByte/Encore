// Loaded server-side so the first paint already holds persisted values: a default flashed for a frame here reads as
// "my choice was lost". See docs/FRONTEND.md#settings.
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApp } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { fallbackJoinOrigin, publicOriginIsHttps } from '$lib/server/public-origin';

/** Resolved here so a deep link (`?tab=you`) paints on its own tab instead of swapping after a frame. */
const TAB_IDS = ['you', 'party', 'server'] as const;
type TabId = (typeof TAB_IDS)[number];
const DEFAULT_TAB: TabId = 'party';

export const load: PageServerLoad = async ({ cookies, request, url }) => {
	const app = getApp();

	// Same bar as the write endpoints: without a join every change here would 401.
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) {
		// Carry the tab through the join gate, or a guest sent here to fix their name lands on Party. `safeNextPath` on `/`
		// is what keeps this `?next=` from becoming an open redirect.
		const next = encodeURIComponent(`/settings${url.search}`);
		redirect(303, `/?next=${next}`);
	}

	// Page data is serialised into the HTML, so the session token — the singer's identity — never goes in.
	const { sessionToken: _t, ...me } = singer;

	const requested = url.searchParams.get('tab');
	const tab: TabId = (TAB_IDS as readonly string[]).includes(requested ?? '') ? (requested as TabId) : DEFAULT_TAB;

	return {
		me,
		tab,
		settings: app.settings.getEffective(app.activeRoomId),
		// What an empty join address resolves to, so the field can show its fallback.
		joinOriginFallback: fallbackJoinOrigin(request, url),
		// Only the server knows the real scheme this phone arrived on; `location.protocol` cannot be trusted for it.
		requestIsHttps: publicOriginIsHttps(request, url)
	};
};
