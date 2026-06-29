// GET /api/me — resolve the current singer from the session cookie (for the phone remote to
// know "who am I"). 401 if not joined.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';

export const GET: RequestHandler = async ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE);
	const singer = getApp().singers.bySessionToken(token);
	if (!singer) return json({ singer: null }, { status: 401 });
	const { sessionToken: _t, ...safe } = singer;
	return json({ singer: safe });
};
