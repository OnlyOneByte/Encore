// POST /api/process — { mediaId } -> request stem-separation for a song. Requires a joined
// singer (no anonymous compute). Flips the media to a processing `file` so rotation holds its slot,
// enqueues the stems job (dedup: two requests → one job), and broadcasts an initial media:status.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { completedStatusFor, mediaStatusFor } from '$lib/server/jobs/media-status';
import { processState, requestProcess, maxProcessesPerSinger } from '$lib/server/jobs/process';
import type { MediaStatus } from '$lib/contract';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) return json({ error: 'not joined' }, { status: 401 });

	const body = await request.json().catch(() => ({}));
	const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });

	// With a durable catalog, "already processed" is the common happy path (a song separated on a
	// previous night), not an error — answer 200 so the phone shows "ready" instead of a red toast.
	/*
	 * `getSettings` IS PASSED, and that is two fixes in one dependency.
	 *
	 * The cap is a setting now (`GlobalSettings.maxProcessesPerSinger`), so `processState` needs a reader to
	 * answer `over-limit` against the configured number rather than a literal. And `requestProcess` below has
	 * ALWAYS taken this dep to choose the fetcher (`needsFetch(source, getSettings()?.defaultFetcher)`) —
	 * this route never supplied it, so every HTTP-requested process picked the fetcher by fallback and the
	 * deployment's own `defaultFetcher` setting reached only the internal callers. One dep, both paths.
	 *
	 * `getGlobal()` rather than `getEffective()`: the dep is typed `() => GlobalSettings`, and effective
	 * settings are `{ global, room }` — handing that over type-checks nowhere and reads `undefined` for every
	 * field, which is how the fetcher gap would have gone unnoticed a second time.
	 */
	const getSettings = () => app.settings.getGlobal();
	const state = processState(
		mediaId,
		{ mediaById: app.mediaById, state: app.state, jobs: app.jobs, getSettings },
		singer.id
	);
	if (state === 'ready') {
		app.publish({ type: 'media:status', mediaId, status: 'ready', pct: 100 });
		return json({ alreadyReady: true, job: null });
	}
	if (state === 'unknown') return json({ error: 'unknown media' }, { status: 409 });
	// A metadata-only source (Spotify): no fetcher can pull its bytes, so this is not a transient
	// refusal and never becomes one. Named explicitly because it used to fall all the way through to
	// the generic `could not start process` below — `processState` answered `'processable'`, so
	// none of the honest arms fired, and the singer got a four-second toast that said nothing about the
	// turn they had just been given, which could never play.
	if (state === 'not-processable') {
		return json(
			{
				error: 'that’s a name match, not a playable song — search for it to make karaoke',
				reason: 'not-processable'
			},
			{ status: 409 }
		);
	}
	if (state === 'playing') return json({ error: 'that song is playing right now' }, { status: 409 });
	// This singer is already at their concurrent-process cap. Answer with a real reason the phone can
	// show, and 429 (Too Many Requests) so the surface can tell a limit apart from a generic refusal.
	if (state === 'over-limit') {
		return json(
			{
				error: `you already have ${maxProcessesPerSinger({ getSettings })} songs processing — wait for one to finish`,
				reason: 'over-limit'
			},
			{ status: 429 }
		);
	}

	const job = requestProcess(
		mediaId,
		{ jobs: app.jobs, mediaById: app.mediaById, state: app.state, now: app.now, getSettings },
		singer.id
	);
	if (!job) return json({ error: 'could not start process' }, { status: 409 });

	// The media just flipped to a processing file — persist it so a restart mid-process still knows this
	// song is a file whose stems are pending (the reaper requeues the job; the catalog agrees).
	const m = app.mediaById.get(mediaId);
	if (m) app.media.upsert(m);

	// kick the dispatcher in case a worker is already connected + idle, and show the live bar now
	app.workerHub.dispatch();
	// Where the SONG is, not a hardcoded 'queued'. `enqueue` is idempotent and hands back the EXISTING
	// live job when one is in flight (§6 dedup) — and `processState` returns 'processing' for that case
	// without this route short-circuiting on it, so a second tap on a song already separating used to
	// broadcast 'queued' TO THE WHOLE ROOM and snap every phone's progress strip back to the first chip.
	// That is the same regression the process chain itself had, arriving through the one producer that was
	// still on a literal. Reuses the shared mapping so this endpoint cannot drift from the hub again.
	app.publish({
		type: 'media:status',
		mediaId,
		// A `ready` job goes through the same gate check the hub's completion path uses, so this endpoint
		// cannot announce a singable song that its own gates disagree with either. (`enqueue` treats a
		// completed job as live, so it really can hand one back — see requestProcess.)
		status:
			job.status === 'ready'
				? completedStatusFor(job, m)
				: mediaStatusFor(job, (job.stage as MediaStatus) ?? undefined),
		pct: job.progressPct
	});

	return json({ job: { id: job.id, mediaId, status: job.status } });
};
