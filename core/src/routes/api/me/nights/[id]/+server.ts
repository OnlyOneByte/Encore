// GET /api/me/nights/:id — your own turns in one night. A night you sang nothing in is 404, whoever else did.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { historyOwner } from '$lib/server/nights/service';

export const GET: RequestHandler = async ({ cookies, request, url, params }) => {
	const app = getApp();
	const caller = historyOwner(app, cookies, { request, url });
	if (!caller) return json({ error: 'join first' }, { status: 401 });
	const found = app.nights.night(caller.owner, params.id ?? '');
	if (!found) return json({ error: 'no such night' }, { status: 404 });
	return json({
		// This room's nights in a row, up to this one, that you sang in. Yours alone; no one else's count.
		streak: app.nights.streakAt(caller.owner, found.night.id),
		night: found.night,
		turns: found.turns.map((t) => {
			const media = app.mediaById.get(t.mediaId);
			return {
				mediaId: t.mediaId,
				title: media?.title ?? null,
				artist: media?.artist ?? null,
				startedAt: t.startedAt,
				endedAt: t.endedAt,
				end: t.end,
				keyShift: t.keyShift,
				keyChanges: t.keyChanges,
				guideLevel: t.guideLevel,
				cheers: t.cheers
			};
		})
	});
};
