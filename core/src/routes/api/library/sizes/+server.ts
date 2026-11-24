// GET /api/library/sizes -> LibrarySizes: each ready song's bytes in the media store, plays and Keep. Host only, and apart from /api/library so guests never download it. See docs/SERVER.md#managing-the-library.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { librarySizes } from '$lib/server/media/library-manage';
import { retentionCapBytes } from '$lib/server/media/retention';

export const GET: RequestHandler = async ({ cookies }) => {
	if (!can({ host: isHost(cookies) }, 'operator:read'))
		return json({ error: 'only the host can open this' }, { status: 403 });
	const app = getApp();
	const ready = app.media.listReady().filter((m) => !app.pendingDeletes.has(m.id));
	return json(await librarySizes(ready, app.mediaStore, retentionCapBytes()));
};
