// The DNS-rebinding guard, run by server.ts before any route, /ws included. See docs/SERVER.md#the-host-allowlist.
// Relative imports only: server.ts loads this outside SvelteKit, where `$lib` does not resolve.

import { isIP } from 'node:net';
import { declaredOrigins, requestHost } from '../public-origin';

/** The hostname of a host[:port], lowercased and unbracketed, or null when it is not one. */
function hostnameOf(host: string): string | null {
	if (!host || /[/?#@\s]/.test(host)) return null;
	try {
		return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
	} catch {
		return null;
	}
}

/** ENCORE_ALLOWED_HOSTS (comma-separated names, ports ignored) and the declared addresses. Read per call. */
function namedHosts(): Set<string> {
	const names = (process.env.ENCORE_ALLOWED_HOSTS ?? '').split(',').map((h) => hostnameOf(h.trim()));
	for (const origin of declaredOrigins()) names.push(new URL(origin).hostname.replace(/^\[|\]$/g, ''));
	return new Set(names.filter((n): n is string => !!n));
}

/**
 * Whether a browser could have reached us under this name. Any IP address passes, because a rebinding page is always
 * opened under the attacker's hostname: a browser that sends an IP opened that IP. That covers every LAN address,
 * Docker's port mappings and loopback. `localhost` and `*.localhost` resolve to loopback in the browser itself.
 */
export function hostAllowed(host: string): boolean {
	const name = hostnameOf(host);
	if (name === null) return false;
	return isIP(name) !== 0 || name === 'localhost' || name.endsWith('.localhost') || namedHosts().has(name);
}

/** The refusal for a request under a name we do not answer to, or null to let it through. */
export function refuseForeignHost(request: Request, url: URL): Response | null {
	// A browser always sends Origin on a WebSocket handshake, so one without it is the worker or a script.
	if (url.pathname === '/ws' && !request.headers.has('origin')) return null;
	if (hostAllowed(requestHost(request, url))) return null;
	return new Response(
		"Encore does not answer to this name. Open it by this machine's IP address or localhost, or add the name to ENCORE_ALLOWED_HOSTS.\n",
		{ status: 421, headers: { 'content-type': 'text/plain; charset=utf-8' } }
	);
}
