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
 * Scheme + authority a client should use, e.g. `http://192.168.1.20:3000`.
 *
 * `host` is taken from the Host/X-Forwarded-Host header rather than from `url` so a LAN IP, a
 * tunnel hostname and localhost all produce a URL that resolves from where the request came from.
 */
export function publicOrigin(request: Request, url: URL): string {
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
