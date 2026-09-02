// POST /api/make-karaoke — { mediaId } -> request stem-separation for a song (M7-C6).
// Requires a joined singer (no anonymous compute). Flips the media to a cooking `file` so the
// rotation engine holds its slot, enqueues the stems job (dedup: two requests → one job), and
// broadcasts an initial media:status so every phone shows the ProcessingCard right away.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';
import { cookState, requestMakeKaraoke } from '$server/jobs/make-karaoke';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) return json({ error: 'not joined' }, { status: 401 });

	const body = await request.json().catch(() => ({}));
	const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });

	// B-1: with a durable catalog, "already cooked" is the common happy path (a song separated on a
	// previous night), not an error — answer 200 so the phone shows "ready" instead of a red toast.
	const state = cookState(mediaId, { mediaById: app.mediaById, state: app.state });
	if (state === 'ready') {
		app.publish({ type: 'media:status', mediaId, status: 'ready', pct: 100 });
		return json({ alreadyReady: true, job: null });
	}
	if (state === 'unknown') return json({ error: 'unknown media' }, { status: 409 });
	if (state === 'playing') return json({ error: 'that song is playing right now' }, { status: 409 });

	const job = requestMakeKaraoke(mediaId, { jobs: app.jobs, mediaById: app.mediaById, state: app.state, now: app.now });
	if (!job) return json({ error: 'could not start make-karaoke' }, { status: 409 });

	// The media just flipped to a cooking file — persist it so a restart mid-cook still knows this
	// song is a file whose stems are pending (the reaper requeues the job; the catalog agrees).
	const m = app.mediaById.get(mediaId);
	if (m) app.media.upsert(m);

	// kick the dispatcher in case a worker is already connected + idle, and show the live bar now
	app.workerHub.dispatch();
	app.publish({ type: 'media:status', mediaId, status: job.status === 'ready' ? 'ready' : 'queued', pct: job.progressPct });

	return json({ job: { id: job.id, mediaId, status: job.status } });
};
