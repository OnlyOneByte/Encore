// POST /api/process — { mediaId } -> request stem-separation for a song. Requires a joined singer (no anonymous compute). Flips the media to a processing `file` so rotation holds its slot, enqueues the stems job (dedup: two requests → one job), and broadcasts an initial media:status.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { processState } from '$lib/server/jobs/process';
import { processRefusal, startProcess, stemsPresent } from '$lib/server/jobs/start-process';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) return json({ error: 'not joined' }, { status: 401 });

	const mediaId = requiredString(await readJsonBody(request), 'mediaId');
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });

	// With a durable catalog, "already processed" is the common happy path (a song separated on a previous night), not an error — answer 200 so the phone shows "ready" instead of a red toast. getSettings is passed to BOTH processState (the over-limit check, against the configured cap) and requestProcess (to choose the fetcher via needsFetch) — one dependency, so neither path can drift from the deployment's actual settings. getGlobal(), not getEffective(): this is typed `() => GlobalSettings`, and effective settings are `{ global, room }`, which type-checks nowhere useful.
	const getSettings = () => app.settings.getGlobal();
	// Checked once here because the store is async: a `ready` song whose stems were evicted must be made again.
	const present = await stemsPresent(app, mediaId);
	const state = processState(
		mediaId,
		{ mediaById: app.mediaById, state: app.state, jobs: app.jobs, getSettings, stemsOnDisk: () => present },
		singer.id
	);
	if (state === 'ready') {
		app.publish({ type: 'media:status', mediaId, status: 'ready', pct: 100 });
		return json({ alreadyReady: true, job: null });
	}
	const refused = processRefusal(app, state);
	if (refused) {
		const { status, ...body } = refused;
		return json(body, { status });
	}
	const job = await startProcess(app, mediaId, singer.id, present);
	if (!job) return json({ error: 'could not start process' }, { status: 409 });
	return json({ job: { id: job.id, mediaId, status: job.status } });
};
