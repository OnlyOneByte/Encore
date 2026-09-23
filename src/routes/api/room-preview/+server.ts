// GET /api/room-preview?code=CODE — resolve a scanned/typed join code to a WORDS confirmation for an
// unjoined guest: how many people are here now, a couple of their names, and the identity colours they
// hold. Unauthenticated on purpose and no new exposure: /tv already renders present singers by name on
// the big screen unauthenticated, and /metrics is ungated too — see docs/ARCHITECTURE.md §10. Rooms
// have no name column ({id, code, createdAt}), so the confirmation is built from presence, not a name.
//
// Counts come from `roomMembership` (lib/server/singers/join.ts) — the SAME reader `assertNameFree`
// refuses from, so this sentence and the name-uniqueness rule can never disagree about who is in the
// room. `presence` is a global tracker (not per-room) and `singers.listPublic(roomId)` is not
// presence-filtered on its own, so roomMembership is what scopes both correctly to this room.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { roomMembership } from '$lib/server/singers/join';
import { normalizeRoomCodeInput, CODE_LENGTH } from '$lib/contract';

export const GET: RequestHandler = async ({ url }) => {
	const app = getApp();
	// Normalise the same way the segment entry does, so `abcd23`, `ABCD23` and a QR's raw value all
	// resolve to the same room rather than only the exact-case one.
	const code = normalizeRoomCodeInput(url.searchParams.get('code') ?? '');
	if (code.length !== CODE_LENGTH) {
		// A malformed code is not "room not found" — it never named a room. The phone shows the typed
		// path with this reason rather than a bare form.
		return json({ error: 'That code is not six characters.' }, { status: 400 });
	}

	const room = app.rooms.byCode(code);
	if (!room) {
		return json({ error: `No room is using the code ${code}.` }, { status: 404 });
	}

	// AWAY MEMBERS ARE IN THE ROOM — the grace window's whole premise is that a dropped socket is a
	// locked phone or a walk to the kitchen, not a departure. So they're counted and pipped, and
	// `awayCount` lets the sentence say so rather than claiming they're standing here. Colours ride
	// along in the SAME ORDER as `names` so the join screen's colour ring can draw a hollow pip on
	// every stop someone in the room already holds, without describing two different sets of people.
	const { here, away } = roomMembership(app, room.id);
	// `here` first: a caller that names only a few people should name reachable ones first.
	const members = [...here, ...away];

	return json({
		code,
		presentCount: members.length,
		awayCount: away.length,
		names: members.map((s) => s.displayName),
		colors: members.map((s) => s.color)
	});
};
