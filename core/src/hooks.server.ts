// Every request passes here before its route. See docs/SERVER.md#requests-from-other-sites.
import { json, type Handle } from '@sveltejs/kit';
import { fromOurOrigin, isJsonBody } from '$lib/server/http/same-origin';
import { isHost } from '$lib/server/host-gate';

/** Keyed on the MATCHED route, never the raw path, which a client can percent-encode past a prefix test. The route
 *  checks the host too; this is the second layer. */
const HOST_ONLY_ROUTES = new Set(['/api/metrics']);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const handle: Handle = async ({ event, resolve }) => {
	const { request, url } = event;
	// Every unsafe method on every path, matched route or not, so no spelling of a path skips it.
	if (!SAFE_METHODS.has(request.method)) {
		if (!fromOurOrigin(request, url)) return json({ error: 'request from another site refused' }, { status: 403 });
		if (!isJsonBody(request)) return json({ error: 'send application/json' }, { status: 415 });
	}
	if (event.route.id && HOST_ONLY_ROUTES.has(event.route.id) && !isHost(event.cookies)) {
		return json({ error: 'only the host can open this' }, { status: 403 });
	}
	return resolve(event);
};
