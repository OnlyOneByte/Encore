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

/** Header a proxy uses to report the original scheme. Comma-separated when proxies chain. */
const PROTO_HEADERS = ['x-forwarded-proto', 'x-forwarded-protocol'] as const;

/**
 * Operator override for the whole computation, e.g. `ENCORE_PUBLIC_ORIGIN=http://10.69.1.169:3000`.
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
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		// Deliberately ignored rather than thrown: a typo here must not take the TV screen down. The
		// request-derived value below is a working fallback for phones, which is the majority case.
		console.warn(`[encore] ENCORE_PUBLIC_ORIGIN is not a valid URL, ignoring: ${raw}`);
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		console.warn(`[encore] ENCORE_PUBLIC_ORIGIN must be http or https, ignoring: ${raw}`);
		return null;
	}
	// `origin` normalises away any path, query or trailing slash, so a value copied out of a browser
	// address bar works as-is.
	return parsed.origin;
}

/**
 * Scheme + authority a client should use, e.g. `http://192.168.1.20:3000`.
 *
 * `ENCORE_PUBLIC_ORIGIN` wins outright when set. Otherwise `host` is taken from the
 * Host/X-Forwarded-Host header rather than from `url` so a LAN IP, a tunnel hostname and localhost
 * all produce a URL that resolves from where the request came from.
 */
export function publicOrigin(request: Request, url: URL): string {
	const configured = configuredOrigin();
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
