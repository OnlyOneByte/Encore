// POST /api/make-karaoke — { mediaId } -> request stem-separation for a song (M7-C6).
// Requires a joined singer (no anonymous compute). Flips the media to a cooking `file` so the
// rotation engine holds its slot, enqueues the stems job (dedup: two requests → one job), and
// broadcasts an initial media:status so every phone shows the ProcessingCard right away.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';
import { requestMakeKaraoke } from '$server/jobs/make-karaoke';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) return json({ error: 'not joined' }, { status: 401 });

	const body = await request.json().catch(() => ({}));
	const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });

	const job = requestMakeKaraoke(mediaId, { jobs: app.jobs, mediaById: app.mediaById, state: app.state, now: app.now });
	if (!job) return json({ error: 'unknown media or media is currently playing' }, { status: 409 });

	// kick the dispatcher in case a worker is already connected + idle, and show the live bar now
	app.workerHub.dispatch();
	app.publish({ type: 'media:status', mediaId, status: job.status === 'ready' ? 'ready' : 'queued', pct: job.progressPct });

	return json({ job: { id: job.id, mediaId, status: job.status } });
};
