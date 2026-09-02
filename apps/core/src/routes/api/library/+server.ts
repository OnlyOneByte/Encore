// GET /api/library — the saved-karaoke library (B-1): every song whose stems are already separated
// and on disk. Re-queueing one of these skips the worker entirely (no 1–2 min cook), which is the
// whole point of persisting the catalog. Read-only and unauthenticated, like /api/search — queueing
// still requires a joined singer over the WS hub.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { hydrateMediaCatalog } from '$server/media/repository';

export const GET: RequestHandler = async () => {
	const app = getApp();
	const library = app.media.listReady();
	// The hub validates adds against the runtime catalog, so anything we offer for one-tap re-queue
	// must be resolvable there. Boot hydration already covers this; re-seeding keeps the endpoint
	// honest if a row was written by another path.
	hydrateMediaCatalog(library, app.mediaById);
	return json({ library });
};
