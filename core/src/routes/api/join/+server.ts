// POST /api/join — { displayName, color } -> creates a singer, sets session cookie, returns it.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { doJoin, NameTakenError, RoomNotFoundError } from '$lib/server/singers/join';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { publicOriginIsHttps } from '$lib/server/public-origin';

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	const body = await request.json().catch(() => ({}));
	let result;
	try {
		result = doJoin(getApp(), { displayName: body.displayName, color: body.color, code: body.code });
	} catch (e) {
		// 409, not 400: the request is well-formed, the name is simply spoken for. The phone shows this verbatim, so it has to read as a sentence about the name rather than a validation failure.
		const status = e instanceof NameTakenError ? 409 : e instanceof RoomNotFoundError ? 404 : 400;
		return json({ error: (e as Error).message }, { status });
	}
	cookies.set(SESSION_COOKIE, result.singer.sessionToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		// NOT `url.protocol === 'https:'`: adapter-node reports https for every request unless PROTOCOL_HEADER is set, which would mark this cookie Secure on a plain-HTTP LAN party and get it silently discarded — /join would succeed and /api/me then 401 with no cookie to read. See $lib/server/public-origin.
		secure: publicOriginIsHttps(request, url),
		maxAge: 60 * 60 * 24 * 30
	});
	// ONE cookie, deliberately — no second cookie naming the room, which would have no reader (see $lib/server/realtime/room-scope). The session token IS the room-scope token: it resolves through the singers row to exactly one `room_id`, so a room may never be read from a client-supplied value. The phone gets its own room id from the response body below.
	// don't leak the session token in the body
	const { sessionToken: _t, ...safe } = result.singer;
	return json({ singer: safe, roomId: result.roomId });
};
