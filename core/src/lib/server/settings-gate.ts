// The gate every settings SCOPE route runs, in one place because all three run it and the `?next=` it builds is an
// open-redirect surface. See docs/FRONTEND.md#settings.
//
// ONE GATE, THREE `+page.server.ts` FILES, and deliberately not a `+layout.server.ts`: a layout load does not
// re-run when a client-side navigation moves between its CHILDREN, so a hop from the room scope to the machine
// scope and back would re-mount the second page against the layout's stale snapshot and show a value the server no
// longer holds. A page load re-runs on every navigation, and the read it costs is one SQLite query on the same box,
// which is what makes freshness the cheap option here. Each route then loads only what its own controls read.
import { redirect, type RequestEvent } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';

/**
 * Refuse an unjoined visitor, and answer with the singer MINUS the session token — page data is serialised into
 * the HTML, so the singer's identity never goes in. Throws a redirect, so a caller that ignores the return value
 * is still gated.
 */
export function settingsSinger({ cookies, url }: Pick<RequestEvent, 'cookies' | 'url'>) {
	const app = getApp();

	// Same bar as the write endpoints: without a join every change here would 401.
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) {
		/* Carry the SCOPE through the join gate — `url.pathname`, not the literal `/settings`, or a guest sent here to
		   fix their name lands on the room scope instead. The search string rides along too, which is what keeps a
		   `?next=` on the You scope intact. `safeNextPath` on `/` is what keeps this `?next=` from becoming an open
		   redirect; it passes any same-origin path, so every scope route survives the gate. */
		const next = encodeURIComponent(`${url.pathname}${url.search}`);
		redirect(303, `/?next=${next}`);
	}

	const { sessionToken: _t, ...me } = singer;
	return me;
}
