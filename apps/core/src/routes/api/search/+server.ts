// GET /api/search?q=...&source=youtube|local — proxied search across the resolvers.
// Persists each returned result as a Media row (so it can be queued by id) and registers it in
// the app's mediaById catalog (which the WS hub validates adds against).
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { resultToMedia } from '$server/media/resolver';
import { ulid, type Media } from '@encore/shared';

export const GET: RequestHandler = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim();
	const source = url.searchParams.get('source') === 'local' ? 'local' : 'youtube';
	if (!q) return json({ results: [] });

	const app = getApp();
	const resolver = source === 'local' ? app.localLibrary : app.youtube;
	const found = resolver ? await resolver.search(q, 12) : [];

	// materialize each result into a queue-able Media (dedupe by source+ref so ids are stable)
	const results: Media[] = found.map((r) => {
		const existing = [...app.mediaById.values()].find(
			(m) => m.source === r.source && m.sourceRef === r.sourceRef
		);
		if (existing) return existing;
		const media = resultToMedia(ulid(), r);
		app.mediaById.set(media.id, media);
		return media;
	});

	return json({ results });
};
