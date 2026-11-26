// The MACHINE scope's load: the settings object plus the three things only the server can answer — what an empty
// join address falls back to, whether this phone arrived over https, and which models the connected workers say they
// can run. See $lib/server/settings-gate for the gate itself and for why each scope route loads for itself rather
// than through a `+layout.server.ts`.
import type { PageServerLoad } from './$types';
import { getApp } from '$lib/server/app';
import { settingsLock } from '$lib/server/settings-gate';
import { fallbackJoinOrigin, joinCandidates, publicOriginIsHttps } from '$lib/server/public-origin';
import { offeredModels } from '$lib/server/jobs/offered-models';

export const load: PageServerLoad = ({ cookies, request, url }) => {
	// Throws the join redirect for a visitor who is neither the host nor joined.
	const locked = settingsLock({ cookies, request, url });

	const app = getApp();
	return {
		settings: app.settings.getEffective(app.activeRoomId),
		locked,
		// What an empty join address resolves to, so the field can show its fallback.
		joinOriginFallback: fallbackJoinOrigin(request, url),
		// This box's home-network addresses, so a host on two networks picks one instead of typing an IP.
		joinCandidates: joinCandidates(),
		// Only the server knows the real scheme this phone arrived on; `location.protocol` cannot be trusted for it.
		requestIsHttps: publicOriginIsHttps(request, url),
		// Models the CONNECTED WORKERS reported, rather than a list compiled here. A worker knows what it can
		// actually run; this page used to offer three checkpoints no worker had. Empty when no worker has sent
		// its catalogue yet, which the page treats as "fall back to the built-in engines".
		offeredModels: offeredModels(app.workers.list())
	};
};
