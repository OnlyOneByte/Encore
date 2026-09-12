// The origin a PHONE should use to reach this server, derived from the request rather than trusted
// from `url.origin`.
//
// WHY THIS EXISTS. adapter-node decides the request protocol as:
//
//     protocol_header && headers.get(protocol_header) || "https"
//
// so with no `PROTOCOL_HEADER` configured it reports **https** for every request, including a plain
// HTTP one. `url.origin` is therefore `https://192.168.1.20:3000` on exactly the deployment the README
// documents, and the TV's join QR encoded an https URL that no phone on the LAN could open — the QR
// being the product's primary join path.
//
// It stayed invisible because the usual test path is a Midway tunnel, which really is https end to end,
// so the wrong scheme happened to be the right one.
//
// This process only ever speaks plain HTTP itself; TLS is always terminated upstream (tunnel, reverse
// proxy). So the honest rule is: believe a forwarding header when one is present, and otherwise say
// http, because that is what this socket actually is.

import { getApp } from './app';
import { normalizeJoinOrigin } from '$shared';

/** Header a proxy uses to report the original scheme. Comma-separated when proxies chain. */
const PROTO_HEADERS = ['x-forwarded-proto', 'x-forwarded-protocol'] as const;

/**
 * Operator override for the whole computation, e.g. `ENCORE_PUBLIC_ORIGIN=http://10.69.1.169:3000`.
 *
 * This is the BOOT-TIME declaration; the same address is also settable at runtime as the `joinOrigin`
 * global setting, which takes precedence for the join QR (see `joinOrigin` below). Both exist because
 * they answer to different people: the env var belongs to whoever starts the container, the setting to
 * whoever is standing in the room when the QR turns out to say `localhost`.
 *
 * WHY AN OVERRIDE IS NEEDED AT ALL. Deriving the origin from the request is right for phones — they
 * reached us somehow, and that route is by definition one that works for them. It is wrong for the
 * TV, because the TV's own URL is not necessarily an address anyone else can use:
 *
 *   * On a Windows/WSL2 deployment the server box often CANNOT reach its own LAN address (the WSL
 *     port-proxy forwards traffic arriving from the network, not the host's own loopback path), so
 *     the only URL that opens `/tv` there is `localhost:3000` — which puts `localhost` in the QR and
 *     hands every phone an address pointing at itself.
 *   * Any reverse proxy that forwards neither `X-Forwarded-Host` nor `X-Forwarded-Proto` has the
 *     same effect.
 *
 * In both cases the deployment knows its public address and the request does not. So: honour an
 * explicit setting first, and fall back to the request only when nothing was declared.
 *
 * Read per call rather than cached at module load so the value is picked up on a plain restart
 * without a rebuild, which is what an operator debugging their own network will actually do.
 */
function configuredOrigin(): string | null {
	const raw = (typeof process !== 'undefined' ? process.env?.ENCORE_PUBLIC_ORIGIN : undefined)?.trim();
	if (!raw) return null;
	// Same coercion the stored setting goes through, so the env var and the settings page cannot accept
	// different spellings of the same address.
	const normalized = normalizeJoinOrigin(raw);
	if (!normalized) {
		// Deliberately ignored rather than thrown: a typo here must not take the TV screen down. The
		// request-derived value below is a working fallback for phones, which is the majority case.
		console.warn(`[encore] ENCORE_PUBLIC_ORIGIN is not a usable http(s) origin, ignoring: ${raw}`);
		return null;
	}
	return normalized;
}

/**
 * Scheme + authority a client should use, e.g. `http://192.168.1.20:3000`.
 *
 * `configured` (when non-empty) wins outright. Otherwise `host` is taken from the
 * Host/X-Forwarded-Host header rather than from `url` so a LAN IP, a tunnel hostname and localhost
 * all produce a URL that resolves from where the request came from.
 *
 * Split out from `publicOrigin` so the resolution rule is testable without an app singleton, and so a
 * caller that already holds a declared origin does not have to re-read it.
 */
export function resolveOrigin(request: Request, url: URL, configured: string | null | undefined): string {
	if (configured) return configured;
	const headers = request.headers;
	let proto = '';
	for (const h of PROTO_HEADERS) {
		const raw = headers.get(h);
		if (raw) {
			// A chain of proxies appends; the FIRST entry is the client-facing scheme.
			proto = raw.split(',')[0]!.trim().toLowerCase();
			break;
		}
	}
	if (proto !== 'http' && proto !== 'https') proto = 'http';
	const host = (headers.get('x-forwarded-host') ?? headers.get('host') ?? url.host).split(',')[0]!.trim();
	return `${proto}://${host}`;
}

/**
 * Origin to use for THIS request's own concerns — the scheme the cookie must agree with.
 *
 * Deliberately does NOT consult the stored `joinOrigin` setting: see `joinOrigin()` below.
 */
export function publicOrigin(request: Request, url: URL): string {
	return resolveOrigin(request, url, configuredOrigin());
}

/**
 * Origin the TV advertises for joining — what the QR encodes and what the screen prints.
 *
 * Resolution order, most specific first:
 *   1. the `joinOrigin` GLOBAL SETTING, so an operator can fix a wrong QR from a phone,
 *   2. `ENCORE_PUBLIC_ORIGIN`, the same declaration made at boot,
 *   3. the request, which is only ever right by luck for the TV (see `configuredOrigin`).
 *
 * WHY THIS IS SEPARATE FROM THE COOKIE PATH. The advertised join address and the route a given phone
 * actually took can legitimately differ — a room can advertise a tunnel while a phone on the LAN
 * reaches the box directly over plain http. Deciding the cookie's `Secure` flag from the advertised
 * origin would mark that phone's cookie Secure, the browser would discard it, and /join would appear
 * to succeed while /api/me 401s. Per-request derivation cannot make that mistake: a phone that really
 * came in over the tunnel carries `X-Forwarded-Proto: https` and gets a Secure cookie on its own
 * merits. So: this function answers "where should a phone go", `publicOrigin` answers "how did this
 * phone get here", and they are allowed to disagree.
 *
 * Reads settings per call rather than caching, matching the env var's behaviour — a change from the
 * settings page has to apply without a restart.
 */
export function joinOrigin(request: Request, url: URL): string {
	let stored = '';
	try {
		stored = getApp().settings.getGlobal().joinOrigin;
	} catch {
		// The app singleton is absent under unit load and during prerender; the env var and the request
		// are the correct answers there rather than a failed load.
	}
	return resolveOrigin(request, url, stored || configuredOrigin());
}

/**
 * What an empty `joinOrigin` setting resolves to — env, else this request. Lets the settings UI show
 * the address it would fall back to instead of an empty box the user has to guess at.
 */
export function fallbackJoinOrigin(request: Request, url: URL): string {
	return publicOrigin(request, url);
}

/**
 * Whether the client reached us over https, decided the same way `publicOrigin` decides the scheme.
 *
 * Exists so the session cookie's `Secure` attribute cannot disagree with the join QR. Do NOT use
 * `url.protocol` for this: adapter-node computes the protocol as
 * `protocol_header && headers.get(protocol_header) || "https"`, so with no `PROTOCOL_HEADER` set it
 * reports **https for every request** — which marks the session cookie `Secure` on a plain-HTTP LAN
 * deployment, and the browser then silently discards it.
 *
 * That failure is invisible from both of the places you would look: the server's Set-Cookie header
 * looks correct, and it works on the host box because browsers accept `Secure` over `http://localhost`
 * (localhost is a trustworthy origin). It surfaces only as a phone that reaches /join, posts
 * successfully, and then gets 401 from /api/me because it holds no cookie.
 */
export function publicOriginIsHttps(request: Request, url: URL): boolean {
	return publicOrigin(request, url).startsWith('https:');
}
