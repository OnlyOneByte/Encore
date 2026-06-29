// GET /api/thumb?u=<encoded remote url> — proxied + on-disk-cached thumbnail.
import type { RequestHandler } from '@sveltejs/kit';
import { serveThumb } from '$server/media/thumbs';

export const GET: RequestHandler = async ({ url }) => {
	const u = url.searchParams.get('u');
	if (!u) return new Response('missing u', { status: 400 });
	return serveThumb(u);
};
