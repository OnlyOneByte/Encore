// Resolves a join code to a WORDS confirmation for an unjoined guest. Unauthenticated ON PURPOSE and no new
// exposure: /tv already renders present singers by name unauthenticated. Rooms have no name column, so the
// confirmation is built from PRESENCE.
//
// Counts come from `roomMembership`, the SAME reader `assertNameFree` refuses from, so this sentence and the
// name-uniqueness rule cannot disagree. `presence` is a global tracker and `listPublic` is not
// presence-filtered, so roomMembership is what scopes both to this room.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { roomMembership } from '$lib/server/singers/join';
import { readDevice } from '$lib/server/people/keep';
import { normalizeRoomCodeInput, CODE_LENGTH } from '$lib/contract';

export const GET: RequestHandler = async ({ url, cookies, request }) => {
	const app = getApp();
	// Normalised as the segment entry does, so a QR's raw value and a typed code resolve alike.
	const code = normalizeRoomCodeInput(url.searchParams.get('code') ?? '');
	if (code.length !== CODE_LENGTH) {
		// A malformed code is not "room not found": it never named a room.
		return json({ error: 'That code is not six characters.' }, { status: 400 });
	}

	const room = app.rooms.byCode(code);
	if (!room) {
		return json({ error: `No room is using the code ${code}.` }, { status: 404 });
	}

	// AWAY MEMBERS ARE IN THE ROOM: the grace window's premise is that a dropped socket is a locked phone,
	// not a departure, so they are counted and pipped and `awayCount` lets the sentence say so. Colours ride
	// in the SAME ORDER as `names`, so the colour ring cannot describe two different sets of people.
	const { here, away } = roomMembership(app, room.id);
	// `here` first, so a caller naming only a few people names reachable ones.
	const members = [...here, ...away];

	// Only this phone's own person, from its own device cookie: the name alone never welcomes anyone back.
	const device = readDevice(app, cookies, { request, url });
	return json(
		{
			code,
			presentCount: members.length,
			awayCount: away.length,
			names: members.map((s) => s.displayName),
			colors: members.map((s) => s.color),
			returning: device ? { displayName: device.person.displayName, color: device.person.color } : null
		},
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
