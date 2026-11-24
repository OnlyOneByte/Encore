// GET   /api/me — resolve the current singer from the session cookie (for the phone remote to know
//                 "who am I"). 401 if not joined.
// PATCH /api/me — change your own name and colour, reusing the join-time validators so a rename cannot
//                 reach a name or a colour that joining could not.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { publicSinger, SESSION_COOKIE } from '$lib/server/singers/repository';
import { assertNameFree, NameTakenError, resolveSingerColor } from '$lib/server/singers/join';
import { optionalString, readJsonBody } from '$lib/server/http/json-body';

export const GET: RequestHandler = async ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE);
	const singer = getApp().singers.bySessionToken(token);
	if (!singer) return json({ singer: null }, { status: 401 });
	return json({ singer: publicSinger(singer) });
};

export const PATCH: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	const me = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	// No capability check: this is your OWN profile, which is the one thing a guest needs no standing beyond being themselves to change.
	if (!me) return json({ error: 'join first' }, { status: 401 });

	const body = await readJsonBody(request);
	// A patch: an omitted field keeps its current value rather than resetting it, matching every other settings write in the app.
	const requestedName = optionalString(body, 'displayName');
	const displayName = requestedName === undefined ? me.displayName : requestedName.trim();
	if (!displayName) return json({ error: 'display name required' }, { status: 400 });
	const requestedColor = optionalString(body, 'color');
	// The join's own resolver: an unusable colour gets the farthest free one in the room, not the first preset.
	const color = requestedColor === undefined ? me.color : resolveSingerColor(app, me.roomId, requestedColor, me.id);

	try {
		// Scope to `me.roomId` (uniqueness is per-party) and except `me.id`, or changing your own capitalisation would collide with yourself.
		assertNameFree(app, me.roomId, displayName, me.id);
	} catch (e) {
		const status = e instanceof NameTakenError ? 409 : 400;
		return json({ error: (e as Error).message }, { status });
	}

	const updated = app.singers.updateProfile(me.id, displayName, color);
	if (!updated) return json({ error: 'could not update profile' }, { status: 400 });

	// A kept person carries the new name and colour to the next night.
	if (updated.personId) app.people.update(updated.personId, updated.displayName, updated.color);
	// Broadcast, or the TV's roster chip and "Now singing" lower-third keep the old name until the next full sync.
	const safe = publicSinger(updated);
	app.publish({ type: 'singer:updated', singer: safe });
	return json({ singer: safe });
};
