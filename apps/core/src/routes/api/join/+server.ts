// POST /api/join — { displayName, color } -> creates a singer, sets session cookie, returns it.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { doJoin } from '$server/singers/join';
import { SESSION_COOKIE } from '$server/singers/repository';

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	const body = await request.json().catch(() => ({}));
	let result;
	try {
		result = doJoin(getApp(), { displayName: body.displayName, color: body.color });
	} catch (e) {
		return json({ error: (e as Error).message }, { status: 400 });
	}
	cookies.set(SESSION_COOKIE, result.singer.sessionToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 60 * 60 * 24 * 30
	});
	// don't leak the session token in the body
	const { sessionToken: _t, ...safe } = result.singer;
	return json({ singer: safe });
};
