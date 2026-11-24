// The DNS-rebinding guard, run by server.ts before any route, /ws included. See docs/SERVER.md#the-host-allowlist.
// Relative imports only: server.ts loads this outside SvelteKit, where `$lib` does not resolve.

import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { hostname as osHostname } from 'node:os';
import { declaredOrigins, requestHost } from '../public-origin';

/** Docker writes /.dockerenv and Podman /run/.containerenv; inside either, os.hostname() is the container ID. */
const IN_CONTAINER = existsSync('/.dockerenv') || existsSync('/run/.containerenv');

/**
 * The hostname of a host[:port], lowercased, unbracketed and without one trailing dot, or null when it is not one.
 * `\`, `%` and `,` are refused because WHATWG reads `\` as `/` and percent-decodes, so the name checked would differ.
 */
function hostnameOf(host: string): string | null {
	if (!host || /[/?#@\s\\%,]/.test(host)) return null;
	try {
		const name = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
		return name.replace(/\.$/, '') || null;
	} catch {
		return null;
	}
}

/** This box's own names on a native run: its hostname and that name's mDNS `.local`. None inside a container. */
export function ownNames(inContainer = IN_CONTAINER, hostname = osHostname()): string[] {
	const name = inContainer ? null : hostnameOf(hostname);
	return name ? [...new Set([name, `${name.split('.')[0]}.local`])] : [];
}

/** ENCORE_ALLOWED_HOSTS (comma-separated names, ports ignored), the declared addresses and our own names. Read per call. */
function namedHosts(): Set<string> {
	const names = (process.env.ENCORE_ALLOWED_HOSTS ?? '').split(',').map((h) => hostnameOf(h.trim()));
	for (const origin of declaredOrigins()) names.push(new URL(origin).hostname.replace(/^\[|\]$/g, ''));
	names.push(...ownNames());
	return new Set(names.filter((n): n is string => !!n));
}

/**
 * Whether a browser could have reached us under this name. Any IP address passes, because a rebinding page is always
 * opened under the attacker's hostname: a browser that sends an IP opened that IP. That covers every LAN address,
 * Docker's port mappings and loopback. `localhost` and `*.localhost` resolve to loopback in the browser itself.
 */
function nameAllowed(name: string): boolean {
	return isIP(name) !== 0 || name === 'localhost' || name.endsWith('.localhost') || namedHosts().has(name);
}

/** Whether a raw host[:port] is a name we answer to; false when it is not a host at all. */
export function hostAllowed(host: string): boolean {
	const name = hostnameOf(host);
	return name !== null && nameAllowed(name);
}

const textResponse = (status: number, body: string) =>
	new Response(body, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }
	});

/** For a request whose Host is missing or not a host at all, so it never reaches a route. */
export const unreadableHost = () => textResponse(400, 'Encore could not read the Host of this request.\n');

/** The request's URL, or null when Bun could not build one from its Host (HTTP/1.0 with none, a bare `::1`). */
export function requestUrl(request: Request): URL | null {
	try {
		return new URL(request.url);
	} catch {
		return null;
	}
}

/** The refusal for a request under a name we do not answer to, or null to let it through. */
export function refuseForeignHost(request: Request, url: URL): Response | null {
	// A browser always sends Origin on a WebSocket handshake, so one without it is the worker or a script.
	if (url.pathname === '/ws' && !request.headers.has('origin')) return null;
	const name = hostnameOf(requestHost(request, url));
	if (name === null) return unreadableHost();
	if (nameAllowed(name)) return null;
	// Echoed as plain text, nosniff, from an already-parsed hostname with anything else replaced, and capped.
	const shown = name.replace(/[^a-z0-9.\-:_]/g, '?').slice(0, 100);
	return textResponse(
		421,
		`Encore does not answer to the name "${shown}". Open it by this machine's IP address or localhost, or add ` +
			`the name to ENCORE_ALLOWED_HOSTS (with Docker, in docker/.env) and restart core.\n`
	);
}
