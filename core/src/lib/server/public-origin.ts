// Derived from the request, NEVER `url.origin`: adapter-node's protocol defaults to "https" whenever
// PROTOCOL_HEADER is unset, even on a plain LAN request, so a QR built from it opens on no phone. This
// process only ever speaks plain HTTP itself, so believe a forwarding header when present, else say http.

import { getApp } from './app';
import { normalizeJoinOrigin } from '../contract';

/** Comma-separated when proxies chain. */
const PROTO_HEADERS = ['x-forwarded-proto', 'x-forwarded-protocol'] as const;

/**
 * The operator override, outranked for the join QR by the `joinOrigin` setting. Needed because
 * request-derivation is wrong for the TV: on WSL2 the server cannot reach its own LAN address, and a proxy
 * that drops X-Forwarded-Host has the same effect — so a deployment must be able to DECLARE its address.
 * Read per call, not cached, so a restart picks up a changed env var.
 */
function configuredOrigin(): string | null {
	const raw = (typeof process !== 'undefined' ? process.env?.ENCORE_PUBLIC_ORIGIN : undefined)?.trim();
	if (!raw) return null;
	// The same coercion the stored setting goes through, so the two cannot accept different spellings.
	const normalized = normalizeJoinOrigin(raw);
	if (!normalized) {
		// Ignored rather than thrown: a typo here must not take the TV screen down.
		console.warn(`[encore] ENCORE_PUBLIC_ORIGIN is not a usable http(s) origin, ignoring: ${raw}`);
		return null;
	}
	return normalized;
}

/** A non-empty `configured` wins outright; otherwise `host` comes from Host/X-Forwarded-Host rather than
 *  `url`, so a LAN IP, a tunnel hostname and localhost each resolve from where the request came from. */
export function resolveOrigin(request: Request, url: URL, configured: string | null | undefined): string {
	if (configured) return configured;
	const headers = request.headers;
	let proto = '';
	for (const h of PROTO_HEADERS) {
		const raw = headers.get(h);
		if (raw) {
			// A chain of proxies APPENDS, so the FIRST entry is the client-facing scheme.
			proto = raw.split(',')[0]!.trim().toLowerCase();
			break;
		}
	}
	if (proto !== 'http' && proto !== 'https') proto = 'http';
	const host = (headers.get('x-forwarded-host') ?? headers.get('host') ?? url.host).split(',')[0]!.trim();
	return `${proto}://${host}`;
}

/** The scheme the cookie must agree with. Deliberately does NOT consult `joinOrigin`; see below. */
export function publicOrigin(request: Request, url: URL): string {
	return resolveOrigin(request, url, configuredOrigin());
}

/**
 * What the QR encodes: the `joinOrigin` setting, then ENCORE_PUBLIC_ORIGIN, then the request. Deliberately
 * SEPARATE from `publicOrigin`, because the ADVERTISED address and a phone's actual route can differ — a
 * Secure flag decided from the advertised origin marks a plain-http phone's cookie Secure, the browser
 * drops it silently, and /join appears to succeed while /api/me 401s.
 */
export function joinOrigin(request: Request, url: URL): string {
	let stored = '';
	try {
		stored = getApp().settings.getGlobal().joinOrigin;
	} catch {
		// The app singleton is absent under unit load and prerender.
	}
	return resolveOrigin(request, url, stored || configuredOrigin());
}

/** Lets the settings UI show the address it would fall back to, rather than an empty box. */
export function fallbackJoinOrigin(request: Request, url: URL): string {
	return publicOrigin(request, url);
}

/**
 * Decided the same way `publicOrigin` decides the scheme, NEVER via `url.protocol`. This gates the session
 * cookie's `Secure` attribute, and getting it wrong leaves a Set-Cookie header that looks fine and works on
 * the host itself, surfacing only as a phone that joins yet 401s on /api/me holding no cookie.
 */
export function publicOriginIsHttps(request: Request, url: URL): boolean {
	return publicOrigin(request, url).startsWith('https:');
}
