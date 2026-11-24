// What the three lyrics-fix routes share: the host check, the refusal statuses, and what a change sets off.
// A +server.ts may only export handlers, so this lives beside them. See docs/SERVER.md#lyrics-fixes.
import { json, type Cookies } from '@sveltejs/kit';
import type { EncoreApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { mediaStatusFor } from '$lib/server/jobs/media-status';
import {
	keepReplaced,
	LYRICS_EDIT_MAX_LINE_CHARS,
	LYRICS_EDIT_MAX_LINES,
	type LyricsEditRefusal,
	type LyricsEditResult
} from '$lib/server/jobs/lyrics-edit';
import type { MediaStatus } from '$lib/contract';

const STATUS: Record<LyricsEditRefusal, number> = {
	'unknown-media': 404,
	stale: 409,
	'not-processed': 409,
	'nothing-to-undo': 409,
	'no-text': 400,
	'bad-lines': 400
};
const MESSAGE: Record<LyricsEditRefusal, string> = {
	'unknown-media': 'unknown media',
	stale: 'these lyrics changed since you opened them — reload to see the newer version',
	'not-processed': 'that song is not processed yet — there is nothing to re-time',
	'nothing-to-undo': 'there is nothing to undo',
	'no-text': 'type some lyrics first',
	'bad-lines': `up to ${LYRICS_EDIT_MAX_LINES} lines, each up to ${LYRICS_EDIT_MAX_LINE_CHARS} characters`
};

/** The 403 for anyone but the host, or null. */
export function refuseNonHost(cookies: Pick<Cookies, 'get'>): Response | null {
	if (can({ host: isHost(cookies) }, 'media:edit')) return null;
	return json({ error: "only the host can change a song's lyrics" }, { status: 403 });
}

export function refusal(reason: LyricsEditRefusal): Response {
	return json({ error: MESSAGE[reason], reason }, { status: STATUS[reason] });
}

/** Persist the change, keep what it replaced, start its re-time, and tell every screen. */
export async function finish(app: EncoreApp, mediaId: string, result: LyricsEditResult): Promise<Response> {
	const m = app.mediaById.get(mediaId);
	if (m) app.media.upsert(m);
	if (result.replaced) await keepReplaced(mediaId, result.replaced);
	if (result.job) {
		app.workerHub.dispatch();
		app.publish({
			type: 'media:status',
			mediaId,
			status: mediaStatusFor(result.job, (result.job.stage as MediaStatus) ?? undefined),
			pct: result.job.progressPct
		});
	}
	// The TV reads lyricsRef off its catalog, which a sync replaces.
	app.syncRoom?.();
	return json({ rev: result.rev, ...(result.job ? { job: { id: result.job.id, status: result.job.status } } : {}) });
}
