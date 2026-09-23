// POST /api/delete-media — { mediaId } -> hard-delete a song from the library ENTIRELY: cancels any in-flight process, removes every queue entry (skipping to the next singer if it was playing), unlinks the sidecar FIRST then audio + derived, drops the index row + tags, and broadcasts. Order is enforced in deleteMediaEntirely; this route is the thin HTTP seam beside /api/process that the admin dashboard calls.
// AUTH: gated to a joined singer — every guest today, since there is no host role (see docs/ARCHITECTURE.md §10). Structured so a real host gate slots in at the marked line below without touching the delete itself.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp, buildHubDeps } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { deleteMediaEntirely } from '$lib/server/media/delete';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();

	// AUTH GATE (see header) — replace this line with a host-role capability check when one exists; nothing below depends on WHO the actor is.
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) return json({ error: 'not joined' }, { status: 401 });

	const body = await request.json().catch(() => ({}));
	const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });

	// Route-side HubDeps from the shared app: the delete drives applyQueueOp + reconcileOnReady directly (not handleQueueCommand), so the idempotency ledger is unused — a no-op ledger is correct.
	const hub = buildHubDeps(app, {
		broadcast: (e) => app.publish(e),
		actorSingerId: singer.id,
		listOnline: () => app.presence.online(),
		listAway: () => [],
		seenOp: () => false,
		hasOp: () => false
	});

	const result = deleteMediaEntirely(mediaId, {
		hub,
		media: app.media,
		cancel: { jobs: app.jobs, toWorker: app.toWorker, now: app.now }
	});

	// Unknown media: nothing was deleted. 404 so the dashboard can tell "already gone" from "done".
	if (!result.deleted) return json({ error: 'unknown media' }, { status: 404 });

	return json({
		deleted: true,
		wasPlaying: result.wasPlaying,
		removedEntries: result.removedEntries
	});
};
