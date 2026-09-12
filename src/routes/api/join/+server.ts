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
		// 409, not 400: the request is well-formed, the name is simply spoken for. The phone shows this
		// verbatim, so it has to read as a sentence about the name rather than a validation failure.
		const status = e instanceof NameTakenError ? 409 : e instanceof RoomNotFoundError ? 404 : 400;
		return json({ error: (e as Error).message }, { status });
	}
	cookies.set(SESSION_COOKIE, result.singer.sessionToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		// NOT `url.protocol === 'https:'`: adapter-node reports https for every request unless
		// PROTOCOL_HEADER is set, so that marked this cookie Secure on a plain-HTTP LAN party and the
		// phone discarded it — /join succeeded and /api/me then 401'd with no cookie to read. See
		// $lib/server/public-origin.
		secure: publicOriginIsHttps(request, url),
		maxAge: 60 * 60 * 24 * 30
	});
	// ONE cookie, deliberately. An earlier design also set a second one naming the room this join landed in, on the
	// plan that the room-scoping chain would read it; that chain then chose a different mechanism and the
	// room cookie was left with no reader at all (and was later deleted). The scope token IS the session
	// token: it resolves through the singers row to exactly one `room_id`, which is why a room may not
	// be read from a client-supplied value — see $lib/server/realtime/room-scope. The phone gets its own
	// room id from the response body below, which is all it needs.
	//
	// don't leak the session token in the body
	const { sessionToken: _t, ...safe } = result.singer;
	return json({ singer: safe, roomId: result.roomId });
};
