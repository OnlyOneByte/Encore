// The origin a PHONE should use to reach this server, derived from the request — never `url.origin`.
// adapter-node's protocol defaults to "https" whenever PROTOCOL_HEADER is unset, even for a plain LAN
// HTTP request, so url.origin lies and a QR built from it opens on no phone. This process only ever
// speaks plain HTTP itself (TLS terminates upstream): believe a forwarding header when present, else say http.

import { getApp } from './app';
import { normalizeJoinOrigin } from '../contract';

/** Header a proxy uses to report the original scheme. Comma-separated when proxies chain. */
const PROTO_HEADERS = ['x-forwarded-proto', 'x-forwarded-protocol'] as const;

/**
 * Operator override for the whole computation (e.g. `ENCORE_PUBLIC_ORIGIN=http://10.69.1.169:3000`).
 * Also settable at runtime as the `joinOrigin` setting, which takes precedence for the join QR (see
 * below). Needed because request-derivation is wrong for the TV: on WSL2 the server can't reach its
 * own LAN address (only `localhost` opens `/tv`), and a reverse proxy that drops
 * X-Forwarded-Host/-Proto has the same effect — so the deployment must be able to declare its address
 * when the request can't. Read per call, not cached, so a plain restart picks up a changed env var.
 */
function configuredOrigin(): string | null {
	const raw = (typeof process !== 'undefined' ? process.env?.ENCORE_PUBLIC_ORIGIN : undefined)?.trim();
	if (!raw) return null;
	// Same coercion the stored setting goes through, so the env var and the settings page cannot accept
	// different spellings of the same address.
	const normalized = normalizeJoinOrigin(raw);
	if (!normalized) {
		// Deliberately ignored rather than thrown: a typo here must not take the TV screen down.
		console.warn(`[encore] ENCORE_PUBLIC_ORIGIN is not a usable http(s) origin, ignoring: ${raw}`);
		return null;
	}
	return normalized;
}

/**
 * Scheme + authority a client should use, e.g. `http://192.168.1.20:3000`. `configured` (when
 * non-empty) wins outright; otherwise `host` comes from Host/X-Forwarded-Host rather than `url`, so a
 * LAN IP, a tunnel hostname, and localhost each resolve from where the request actually came from.
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

/** Origin for THIS request's own concerns — the scheme the cookie must agree with. Deliberately does
 *  NOT consult the stored `joinOrigin` setting; see `joinOrigin()` below. */
export function publicOrigin(request: Request, url: URL): string {
	return resolveOrigin(request, url, configuredOrigin());
}

/**
 * Origin the TV advertises for joining (what the QR encodes), resolved most-specific-first: the
 * `joinOrigin` global setting, then ENCORE_PUBLIC_ORIGIN, then the request. Deliberately SEPARATE from
 * the cookie path (`publicOrigin`): the advertised join address and a given phone's actual route can
 * differ (a room can advertise a tunnel while a LAN phone connects directly over http) — deciding a
 * cookie's Secure flag from the advertised origin would mark a plain-http phone's cookie Secure, the
 * browser would silently drop it, and /join would appear to succeed while /api/me 401s. Reads settings
 * per call so a change from the settings page applies without a restart.
 */
export function joinOrigin(request: Request, url: URL): string {
	let stored = '';
	try {
		stored = getApp().settings.getGlobal().joinOrigin;
	} catch {
		// App singleton absent under unit load / prerender — env var and request are the right fallback.
	}
	return resolveOrigin(request, url, stored || configuredOrigin());
}

/** What an empty `joinOrigin` setting resolves to — env, else this request. Lets the settings UI show
 *  the address it would fall back to instead of an empty box the user has to guess at. */
export function fallbackJoinOrigin(request: Request, url: URL): string {
	return publicOrigin(request, url);
}

/**
 * Whether the client reached us over https — decided the same way `publicOrigin` decides the scheme,
 * NEVER via `url.protocol` (which adapter-node reports as https even on plain LAN http when
 * PROTOCOL_HEADER is unset). This gates the session cookie's `Secure` attribute: get it wrong and the
 * Set-Cookie header looks fine, works on the host itself (browsers trust `Secure` on localhost), and
 * only surfaces as a phone that joins successfully yet gets 401 from /api/me because it holds no cookie.
 */
export function publicOriginIsHttps(request: Request, url: URL): boolean {
	return publicOrigin(request, url).startsWith('https:');
}
