// POST /api/lyrics-reselect — { mediaId, ref } | { mediaId, text } -> re-pick a song's lyrics and
// re-time them. A fallback for when the ranker chose the wrong lyrics set: the user either
// picks a different STORED candidate by ref, or PASTES words (a `manual` source), and the align step
// re-times the chosen text from the retained vocals stem.
//
// Requires a joined singer, like /api/make-karaoke — no anonymous compute. No capability gate beyond
// "joined" (owner ruling Q1=A: any joined singer may re-pick, same as every other room control).
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { mediaStatusFor } from '$lib/server/jobs/media-status';
import { requestLyricsReselect, type ReselectRefusal } from '$lib/server/jobs/make-karaoke';
import type { MediaStatus } from '$shared';

// The honest status code for each refusal — a 409 (conflict with the song's current state) except an
// unknown media (404) and an empty/absent body field (400), so the phone can tell them apart.
const REFUSAL_STATUS: Record<ReselectRefusal, number> = {
	'unknown-media': 404,
	'not-cooked': 409,
	'unknown-candidate': 409,
	'no-text': 400
};
const REFUSAL_MESSAGE: Record<ReselectRefusal, string> = {
	'unknown-media': 'unknown media',
	'not-cooked': 'that song is not cooked yet — there is nothing to re-time',
	'unknown-candidate': 'that lyrics option is no longer available',
	'no-text': 'paste some lyrics first'
};

export const POST: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) return json({ error: 'not joined' }, { status: 401 });

	const body = await request.json().catch(() => ({}));
	const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });

	const ref = typeof body.ref === 'string' ? body.ref : undefined;
	const text = typeof body.text === 'string' ? body.text : undefined;
	// Exactly one of ref / text names the pick. A paste with only whitespace is a no-text refusal, not
	// a silent no-op, so the phone can say why nothing happened.
	if (!ref && !(text && text.trim())) {
		return json({ error: REFUSAL_MESSAGE['no-text'], reason: 'no-text' }, { status: 400 });
	}

	const result = requestLyricsReselect(
		mediaId,
		{ ref, text },
		{ jobs: app.jobs, mediaById: app.mediaById, state: app.state, now: app.now },
		singer.id
	);
	if (typeof result === 'string') {
		return json({ error: REFUSAL_MESSAGE[result], reason: result }, { status: REFUSAL_STATUS[result] });
	}

	// The override + the fresh align job just changed this media — persist so a restart mid-re-time
	// still knows the human's pick and that lyrics are pending (the reaper requeues the job).
	const m = app.mediaById.get(mediaId);
	if (m) app.media.upsert(m);

	// Kick the dispatcher in case an idle align-capable worker is already connected, and show the live
	// bar now. The align job is where the SONG is; reuse the shared mapping so this cannot drift.
	app.workerHub.dispatch();
	app.publish({
		type: 'media:status',
		mediaId,
		status: mediaStatusFor(result.job, (result.job.stage as MediaStatus) ?? undefined),
		pct: result.job.progressPct
	});

	return json({ job: { id: result.job.id, mediaId, status: result.job.status }, ref: result.ref });
};
