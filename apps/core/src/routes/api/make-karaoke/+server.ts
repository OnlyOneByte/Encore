// POST /api/make-karaoke — { mediaId } -> request stem-separation for a song. Requires a joined
// singer (no anonymous compute). Flips the media to a cooking `file` so rotation holds its slot,
// enqueues the stems job (dedup: two requests → one job), and broadcasts an initial media:status.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';
import { completedStatusFor, mediaStatusFor } from '$server/jobs/media-status';
import { cookState, requestMakeKaraoke, MAX_CONCURRENT_COOKS_PER_SINGER } from '$server/jobs/make-karaoke';
import type { MediaStatus } from '@encore/shared';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) return json({ error: 'not joined' }, { status: 401 });

	const body = await request.json().catch(() => ({}));
	const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });

	// With a durable catalog, "already cooked" is the common happy path (a song separated on a
	// previous night), not an error — answer 200 so the phone shows "ready" instead of a red toast.
	const state = cookState(mediaId, { mediaById: app.mediaById, state: app.state, jobs: app.jobs }, singer.id);
	if (state === 'ready') {
		app.publish({ type: 'media:status', mediaId, status: 'ready', pct: 100 });
		return json({ alreadyReady: true, job: null });
	}
	if (state === 'unknown') return json({ error: 'unknown media' }, { status: 409 });
	if (state === 'playing') return json({ error: 'that song is playing right now' }, { status: 409 });
	// This singer is already at their concurrent-cook cap. Answer with a real reason the phone can
	// show, and 429 (Too Many Requests) so the surface can tell a limit apart from a generic refusal.
	if (state === 'over-limit') {
		return json(
			{
				error: `you already have ${MAX_CONCURRENT_COOKS_PER_SINGER} songs cooking — wait for one to finish`,
				reason: 'over-limit'
			},
			{ status: 429 }
		);
	}

	const job = requestMakeKaraoke(
		mediaId,
		{ jobs: app.jobs, mediaById: app.mediaById, state: app.state, now: app.now },
		singer.id
	);
	if (!job) return json({ error: 'could not start make-karaoke' }, { status: 409 });

	// The media just flipped to a cooking file — persist it so a restart mid-cook still knows this
	// song is a file whose stems are pending (the reaper requeues the job; the catalog agrees).
	const m = app.mediaById.get(mediaId);
	if (m) app.media.upsert(m);

	// kick the dispatcher in case a worker is already connected + idle, and show the live bar now
	app.workerHub.dispatch();
	// Where the SONG is, not a hardcoded 'queued'. `enqueue` is idempotent and hands back the EXISTING
	// live job when one is in flight (§6 dedup) — and `cookState` returns 'cooking' for that case
	// without this route short-circuiting on it, so a second tap on a song already separating used to
	// broadcast 'queued' TO THE WHOLE ROOM and snap every phone's progress strip back to the first chip.
	// That is the same regression the cook chain itself had, arriving through the one producer that was
	// still on a literal. Reuses the shared mapping so this endpoint cannot drift from the hub again.
	app.publish({
		type: 'media:status',
		mediaId,
		// A `ready` job goes through the same gate check the hub's completion path uses, so this endpoint
		// cannot announce a singable song that its own gates disagree with either. (`enqueue` treats a
		// completed job as live, so it really can hand one back — see requestMakeKaraoke.)
		status:
			job.status === 'ready'
				? completedStatusFor(job, m)
				: mediaStatusFor(job, (job.stage as MediaStatus) ?? undefined),
		pct: job.progressPct
	});

	return json({ job: { id: job.id, mediaId, status: job.status } });
};
