// POST /api/join — { displayName, color } -> creates a singer, sets session cookie, returns it.
// { returning: true } joins as the person this phone is kept for; see docs/SERVER.md#kept-people.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { doJoin, NameTakenError, RoomNotFoundError } from '$lib/server/singers/join';
import { publicSinger } from '$lib/server/singers/repository';
import { setSessionCookie } from '$lib/server/singers/session-cookie';
import { readDevice, rotateDevice } from '$lib/server/people/keep';
import { optionalString, readJsonBody, requiredString } from '$lib/server/http/json-body';

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	const app = getApp();
	const body = await readJsonBody(request);
	const device = body.returning === true ? readDevice(app, cookies, { request, url }) : null;
	if (body.returning === true && !device) {
		return json({ error: "This phone isn't kept any more. Join with your name." }, { status: 401 });
	}
	let result;
	try {
		result = doJoin(app, {
			// A returning phone may still send a name, when someone in the room already holds its own.
			displayName:
				optionalString(body, 'displayName') ?? device?.person.displayName ?? requiredString(body, 'displayName'),
			color: device ? device.person.color : optionalString(body, 'color'),
			code: optionalString(body, 'code'),
			personId: device?.person.id,
			rotating: device ? !device.viaGrace : false
		});
	} catch (e) {
		// 409, not 400: the request is well-formed, the name is simply spoken for. The phone shows this verbatim, so it has to read as a sentence about the name rather than a validation failure.
		const status = e instanceof NameTakenError ? 409 : e instanceof RoomNotFoundError ? 404 : 400;
		// The person's other nights already ended, so rotate here too, or a copied device cookie could still return.
		if (device && e instanceof NameTakenError) rotateDevice(app, cookies, device, { request, url });
		return json({ error: (e as Error).message }, { status });
	}
	// A fresh device token on every return, so a copied cookie works only until the owner's next join.
	if (device) rotateDevice(app, cookies, device, { request, url });
	setSessionCookie(cookies, result.singer.sessionToken, request, url);
	// ONE cookie, deliberately — no second cookie naming the room, which would have no reader (see $lib/server/realtime/room-scope). The session token IS the room-scope token: it resolves through the singers row to exactly one `room_id`, so a room may never be read from a client-supplied value. The phone gets its own room id from the response body below.
	return json({ singer: publicSinger(result.singer), roomId: result.roomId });
};
