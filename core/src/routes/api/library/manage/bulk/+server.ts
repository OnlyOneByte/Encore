// POST /api/library/manage/bulk — { action: keep|unkeep|delete|undo, mediaIds } -> one action over a selection, with what was skipped and why. Host only. See docs/SERVER.md#managing-the-library.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readJsonBody } from '$lib/server/http/json-body';
import { BULK_MAX, bulkManage, type BulkAction } from '$lib/server/media/library-manage';
import { DELETE_UNDO_MS } from '$lib/contract';

const NEEDS = { keep: 'media:edit', unkeep: 'media:edit', delete: 'media:delete', undo: 'media:delete' } as const;

export const POST: RequestHandler = async ({ request, cookies }) => {
	const actor = { host: isHost(cookies) };
	// A guest is refused before the body is read, whatever it says.
	if (!can(actor, 'media:edit')) return json({ error: 'only the host can change songs' }, { status: 403 });
	const body = await readJsonBody(request);
	const action = body.action;
	if (typeof action !== 'string' || !Object.hasOwn(NEEDS, action))
		return json({ error: 'action must be keep, unkeep, delete or undo' }, { status: 400 });
	if (!can(actor, NEEDS[action as BulkAction]))
		return json({ error: 'only the host can change songs' }, { status: 403 });
	const ids = body.mediaIds;
	if (
		!Array.isArray(ids) ||
		ids.length === 0 ||
		ids.length > BULK_MAX ||
		!ids.every((id) => typeof id === 'string' && id)
	)
		return json({ error: `mediaIds must be 1 to ${BULK_MAX} song ids` }, { status: 400 });

	const app = getApp();
	const result = await bulkManage(app, action as BulkAction, ids as string[]);
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
