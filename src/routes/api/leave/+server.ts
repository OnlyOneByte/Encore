// POST /api/leave — leave the room on purpose.
//
// GET /api/leave reports what it would cost, so the phone can name the consequence in the
// confirm rather than asking "Are you sure?" about an outcome the guest cannot see. There is no undo:
// the remove-undo elsewhere is a client-side re-add inside a five-second toast, and after this the cookie
// is gone and the singer is forgotten, so the confirm is the only place the cost can be stated.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { doLeave, removableOnLeave } from '$lib/server/singers/leave';

export const GET: RequestHandler = async ({ cookies }) => {
	const app = getApp();
	const me = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!me) return json({ error: 'join first' }, { status: 401 });
	const removable = removableOnLeave(app, me.id);
	const playing = app.state.entries.find((e) => e.singerId === me.id && e.status === 'playing');
	return json({ queuedCount: removable.length, hasPlaying: !!playing });
};

export const POST: RequestHandler = async ({ cookies }) => {
	const app = getApp();
	const me = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!me) return json({ error: 'join first' }, { status: 401 });

	const result = doLeave(app, me.id);
	// Clear the cookie, or reopening the page silently rehydrates them as the same singer and the leave
	// looks like it did not take. Same attributes as the join set, since a delete must match to apply.
	cookies.delete(SESSION_COOKIE, { path: '/' });
	// Announce separately from the queue patches: a client needs to drop them from its roster even when
	// they had no songs to remove, so there was no patch to infer it from.
	app.publish({ type: 'singer:left', singerId: me.id });
	return json(result);
};
