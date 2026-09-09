// GET /api/room-preview?code=CODE — resolve a scanned/typed join code to a WORDS confirmation for an
// unjoined guest: how many people are here now, and a couple of their names (#834, XR-PH-14, Q1-B).
//
// Unauthenticated on purpose, and it is no new exposure: /tv reads no session and already renders the
// present singers BY NAME on the big screen (`lib/tv/screen.ts`), and /metrics is ungated too — there is
// no operator identity in this app, so who is in the room is already readable by any phone on the LAN.
//
// Rooms have no name column (schema.ts is {id, code, createdAt}) and no naming surface, so the
// confirmation is built from presence, not a room name — that is exactly what Q1-B decided over the
// rejected "Room ABCD23 · 6 people here", which re-presents the code XR-PH-14 says has no function left
// once the guest has arrived.
//
// The count is the INTERSECTION of two things that each over-count alone: `presence.online()` is one
// global tracker (not per-room), so it counts other rooms' phones; `singers.listPublic(roomId)` is not
// presence-filtered, so it counts singers who have gone. Present-in-THIS-room is their intersection.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { normalizeRoomCodeInput, CODE_LENGTH } from '@encore/shared';

export const GET: RequestHandler = async ({ url }) => {
	const app = getApp();
	// Normalise the same way the segment entry does, so `abcd23`, `ABCD23` and a QR's raw value all
	// resolve to the same room rather than only the exact-case one.
	const code = normalizeRoomCodeInput(url.searchParams.get('code') ?? '');
	if (code.length !== CODE_LENGTH) {
		// A malformed code is not "room not found" — it never named a room. The phone shows the typed
		// path with this reason rather than a bare form (XR-PH-14 error-identification half).
		return json({ error: 'That code is not six characters.' }, { status: 400 });
	}

	const room = app.rooms.byCode(code);
	if (!room) {
		return json({ error: `No room is using the code ${code}.` }, { status: 404 });
	}

	// Present = live socket AND a singer of THIS room. Names are for the confirmation sentence; the
	// count is the whole set, not just the named ones.
	const onlineIds = new Set(app.presence.online());
	const present = app.singers.listPublic(room.id).filter((s) => onlineIds.has(s.id));
	const names = present.map((s) => s.displayName);

	return json({ code, presentCount: present.length, names });
};
