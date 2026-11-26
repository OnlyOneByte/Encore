// POST /api/library/manage/bulk — { action: keep|unkeep|delete|undo|remake|remake-lyrics, mediaIds } -> one action over a selection, with what was skipped and why. Host only. See docs/SERVER.md#managing-the-library.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readJsonBody } from '$lib/server/http/json-body';
import { BULK_MAX, bulkManage, type BulkAction } from '$lib/server/media/library-manage';
import { DELETE_UNDO_MS } from '$lib/contract';
import { requestRemake } from '$lib/server/jobs/process';
import { waitsForTurn, inTurn } from '$lib/server/jobs/dispatch';

/** Far past any real id (a ULID is 26); a longer one is a malformed request, not a song. */
const ID_MAX = 128;
const NEEDS = {
	keep: 'media:edit',
	unkeep: 'media:edit',
	delete: 'media:delete',
	undo: 'media:delete',
	remake: 'media:edit',
	'remake-lyrics': 'media:edit'
} as const;

export const POST: RequestHandler = async ({ request, cookies }) => {
	const actor = { host: isHost(cookies) };
	// A guest is refused before the body is read, whatever it says.
	if (!can(actor, 'media:edit')) return json({ error: 'only the host can change songs' }, { status: 403 });
	const body = await readJsonBody(request);
	const action = body.action;
	if (typeof action !== 'string' || !Object.hasOwn(NEEDS, action))
		return json({ error: 'action must be keep, unkeep, delete, undo, remake or remake-lyrics' }, { status: 400 });
	if (!can(actor, NEEDS[action as BulkAction]))
		return json({ error: 'only the host can change songs' }, { status: 403 });
	const ids = body.mediaIds;
	if (
		!Array.isArray(ids) ||
		ids.length === 0 ||
		ids.length > BULK_MAX ||
		!ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= ID_MAX)
	)
		return json({ error: `mediaIds must be 1 to ${BULK_MAX} song ids` }, { status: 400 });

	const app = getApp();
	// Each remake waits behind every guest's pick (`requestRemake`), so a whole library is safe. A sound remake also waits
	// for its song's turn; a lyrics one does not, since the TV swaps new lyrics in between lines (`inTurn` counts those).
	let afterTurn = 0;
	let swapLive = 0;
	const lyrics = action === 'remake-lyrics';
	const { entries, playback } = app.state;
	const result = await bulkManage(app, action as BulkAction, ids as string[], (m) => {
		const job = requestRemake(m, { jobs: app.jobs, now: () => app.now() }, lyrics ? 'align-remake' : 'stems-remake');
		if (waitsForTurn(job, entries, playback.currentEntryId)) afterTurn++;
		else if (lyrics && inTurn(m.id, entries, playback.currentEntryId)) swapLive++;
	});
	if (action === 'remake' || lyrics) {
		app.workerHub.dispatch();
		return json({ ...result, afterTurn, ...(lyrics ? { swapLive } : {}) });
	}
	// Phones re-read Library on `canceled` and `ready`, so a deleted song leaves every screen and an Undo brings it back.
	if (action === 'delete' || action === 'undo')
		for (const mediaId of result.done)
			app.publish({
				type: 'media:status',
				mediaId,
				status: action === 'delete' ? 'canceled' : 'ready',
				pct: action === 'delete' ? 0 : 100
			});
	return json({ ...result, ...(action === 'delete' ? { undoMs: DELETE_UNDO_MS } : {}) });
};
