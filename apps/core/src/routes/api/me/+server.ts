// GET   /api/me — resolve the current singer from the session cookie (for the phone remote to know
//                 "who am I"). 401 if not joined.
// PATCH /api/me — change your own name and colour.
//
// PATCH exists because the singers table was create/read only: a guest who mistyped their name, or who
// picked a colour they then saw next to someone else's on the TV, was stuck with it for the night. It
// reuses the join-time validators rather than its own, so a rename cannot reach a name or a colour that
// joining could not.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';
import { assertNameFree, NameTakenError } from '$server/singers/join';
import { normalizeSingerColor } from '@encore/shared';

export const GET: RequestHandler = async ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE);
	const singer = getApp().singers.bySessionToken(token);
	if (!singer) return json({ singer: null }, { status: 401 });
	// `roomId` goes too, not just the token: this projects a StoredSinger onto the wire `Singer`, and
	// `room_id` is a server-side scoping key. The phone already learned its room from /api/join.
	const { sessionToken: _t, roomId: _r, ...safe } = singer;
	return json({ singer: safe });
};

export const PATCH: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	const me = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	// No capability check: this is your OWN profile, which is the one thing a guest needs no standing
	// beyond being themselves to change.
	if (!me) return json({ error: 'join first' }, { status: 401 });

	const body = await request.json().catch(() => ({}));
	// A patch: an omitted field keeps its current value rather than resetting it, matching every other
	// settings write in the app.
	const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : me.displayName;
	if (!displayName) return json({ error: 'display name required' }, { status: 400 });
	const color = typeof body.color === 'string' ? normalizeSingerColor(body.color) : me.color;

	try {
		// Scope to `me.roomId` — uniqueness is per-party — and except `me.id`, or changing your
		// own capitalisation would collide with yourself.
		assertNameFree(app, me.roomId, displayName, me.id);
	} catch (e) {
		const status = e instanceof NameTakenError ? 409 : 400;
		return json({ error: (e as Error).message }, { status });
	}

	const updated = app.singers.updateProfile(me.id, displayName, color);
	if (!updated) return json({ error: 'could not update profile' }, { status: 400 });

	const { sessionToken: _t, roomId: _r, ...safe } = updated;
	// Broadcast, or the TV's roster chip and the "Now singing" lower-third keep the old name until the
	// next full sync — which on a quiet room is not until someone touches the queue.
	//
	// `roomId` is stripped above as well as the token: this frame is typed `PublicSinger`, which has no
	// room field, and a variable (rather than an inline literal) fires no excess-property check — so
	// nothing but this strip keeps the wire shape equal to its declared type.
	app.publish({ type: 'singer:updated', singer: safe });
	return json({ singer: safe });
};
