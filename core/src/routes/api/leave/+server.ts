// POST /api/leave — leave the room on purpose; no undo (the cookie is cleared and the singer
// forgotten). GET /api/leave reports what it would cost, so the phone can name the consequence in the
// confirm rather than asking "Are you sure?" about an outcome the guest cannot see.
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
	// The session ends on the SERVER, not only in this tab's cookie jar: the token stops resolving, and every socket
	// opened with it (this phone's other tabs) stops acting as them and is closed, so no tab keeps queuing as a guest who left.
	app.singers.endSession(me.id);
	app.releaseSinger?.(me.id);
	// Clear with the SAME attributes the join set — a delete must match to apply, or reopening the page silently rehydrates them as the same singer and the leave looks like it did not take.
	cookies.delete(SESSION_COOKIE, { path: '/' });
	// Announced separately from the queue patches, since a client with no songs removed gets no patch to infer this from.
	app.publish({ type: 'singer:left', singerId: me.id });
	return json(result);
};
