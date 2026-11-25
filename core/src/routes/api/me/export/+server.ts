// GET /api/me/export — Download my data: one JSON file of everything Encore keeps about you, with no token or hash.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { historyOwner } from '$lib/server/nights/service';
import { exportFor } from '$lib/server/songs/service';

export const GET: RequestHandler = async ({ cookies, request, url }) => {
	const app = getApp();
	const caller = historyOwner(app, cookies, { request, url });
	if (!caller) return json({ error: 'join first' }, { status: 401 });
	return json(exportFor(app, caller.owner, caller.me), {
		headers: {
			'content-disposition': 'attachment; filename="encore-my-data.json"',
			'cache-control': 'private, no-store'
		}
	});
};
