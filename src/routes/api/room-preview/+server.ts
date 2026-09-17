// GET /api/room-preview?code=CODE — resolve a scanned/typed join code to a WORDS confirmation for an
// unjoined guest: how many people are here now, a couple of their names, and the identity colours they
// hold (XR-PH-14, Q1-B).
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
// The count comes from `roomMembership`, which is also what the name-uniqueness rule refuses from — see
// the note at the count below for the contradiction that sharing removes. Both halves still need
// scoping, and that reader does it: `presence` is one global tracker (not per-room), so it knows about
// other rooms' phones, while `singers.listPublic(roomId)` is not presence-filtered and would count
// singers who have long gone.
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
		// path with this reason rather than a bare form (XR-PH-14 error-identification half).
		return json({ error: 'That code is not six characters.' }, { status: 400 });
	}

	const room = app.rooms.byCode(code);
	if (!room) {
		return json({ error: `No room is using the code ${code}.` }, { status: 404 });
	}

	// ── WHO COUNTS AS IN THE ROOM ────────────────────────────────────────────────────────────────────
	//
	// `roomMembership` (lib/server/singers/join.ts), which is the SAME reader `assertNameFree` refuses
	// from. That sharing is the fix, not a tidy-up: this endpoint used to count `presence.online()` — a
	// live socket — while the name rule refuses anyone not yet `gone`, so the join screen could say
	//
	//     "This room is empty right now — you'll be the first here."
	//
	// and then reject the submit with `the name "Maya" is taken`, while /tv rendered "Maya AWAY" on its
	// roster the whole time. Two populations, one room. There is now one.
	//
	// AWAY MEMBERS ARE IN THE ROOM, which is the grace window's whole premise — a dropped socket is a
	// locked phone or a walk to the kitchen, not a departure. So they are counted, their colours are
	// pipped, and `awayCount` lets the sentence say so rather than claiming they are standing here.
	//
	// COLOURS RIDE ALONG WITH THE NAMES, for the join screen's colour ring: it draws a hollow pip on every
	// stop somebody in the room is already holding, so a guest can avoid arriving as a near-twin of the
	// singer next to them on the TV roster. Same order as `names`, from the same list, so the two cannot
	// describe different sets of people. No new exposure — `/tv` already renders the names and colour dots
	// of everyone in the room, away ones included, unauthenticated, for the whole room to read.
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
