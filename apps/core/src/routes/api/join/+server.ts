// POST /api/join — { displayName, color } -> creates a singer, sets session cookie, returns it.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { doJoin, NameTakenError, RoomNotFoundError } from '$server/singers/join';
import { SESSION_COOKIE, ROOM_COOKIE } from '$server/singers/repository';
import { publicOriginIsHttps } from '$server/public-origin';

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
		// $server/public-origin.
		secure: publicOriginIsHttps(request, url),
		maxAge: 60 * 60 * 24 * 30
	});
	// The room this join landed in, so every later request from this phone (queue, settings, the
	// realtime socket) knows its party without re-resolving a code. #654 sets the identity; the chain
	// that scopes queue/playback to a room (#655/#656) reads it. Not httpOnly-sensitive on its own — it
	// is an opaque room id, not a credential — but kept server-set and lax alongside the session.
	cookies.set(ROOM_COOKIE, result.roomId, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: publicOriginIsHttps(request, url),
		maxAge: 60 * 60 * 24 * 30
	});
	// don't leak the session token in the body
	const { sessionToken: _t, ...safe } = result.singer;
	return json({ singer: safe, roomId: result.roomId });
};
