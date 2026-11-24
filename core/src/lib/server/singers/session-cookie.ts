// The `encore_singer` cookie, set by a join and swapped by Keep me. See docs/SERVER.md#sessions-and-cookies.
import type { Cookies } from '@sveltejs/kit';
import { publicOriginIsHttps } from '../public-origin';
import { SESSION_COOKIE } from './repository';

export function setSessionCookie(cookies: Pick<Cookies, 'set'>, token: string, request: Request, url: URL): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		// NOT `url.protocol === 'https:'`: adapter-node reports https for every request unless PROTOCOL_HEADER is set, which would mark this cookie Secure on a plain-HTTP LAN party and get it silently discarded — /join would succeed and /api/me then 401 with no cookie to read. See $lib/server/public-origin.
		secure: publicOriginIsHttps(request, url),
		maxAge: 60 * 60 * 24 * 30
	});
}
