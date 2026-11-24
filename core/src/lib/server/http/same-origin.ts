// The CSRF and cross-site WebSocket guard, shared by hooks.server.ts (/api) and server.ts (/ws). See docs/SERVER.md#requests-from-other-sites.
// Relative imports only: server.ts loads this outside SvelteKit, where `$lib` does not resolve.

import { joinOrigin, resolveOrigin } from '../public-origin';

/** The host[:port] a browser named as the page that sent this request, or null when it named none. */
function senderHost(request: Request): string | null {
	const raw = request.headers.get('origin') ?? request.headers.get('referer');
	if (raw === null) return null;
	try {
		return new URL(raw).host;
	} catch {
		// The literal "null" a sandboxed iframe sends lands here: a browser that will not say who sent it is refused.
		return '';
	}
}

/**
 * Whether a browser could have sent this from a page of ours. Allowed: the request's own host, the configured public
 * origin and the join address. No Origin and no Referer is a non-browser client (the worker, curl, a probe), which
 * carries no ambient cookie a third-party page could borrow, so it passes.
 */
export function fromOurOrigin(request: Request, url: URL): boolean {
	const sender = senderHost(request);
	if (sender === null) return true;
	if (!sender) return false;
	const ours = new Set([resolveOrigin(request, url, null), joinOrigin(request, url)].map((o) => new URL(o).host));
	const configured = process.env.ENCORE_PUBLIC_ORIGIN?.trim();
	if (configured) {
		try {
			ours.add(new URL(configured).host);
		} catch {
			// Ignored here exactly as public-origin.ts ignores it.
		}
	}
	return ours.has(sender);
}

/** A body a cross-site <form> cannot send: a form can only post urlencoded, multipart or text/plain. */
export function isJsonBody(request: Request): boolean {
	const type = request.headers.get('content-type');
	if (type === null) return request.headers.get('content-length') === '0' || !request.body;
	return type.split(';')[0]!.trim().toLowerCase() === 'application/json';
}
