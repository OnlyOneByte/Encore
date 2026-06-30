// GET /media/<sourceRef> — serve a library/stems file through the configured MediaStore (local
// volume or, when proxying an object store, streamed from S3/MinIO). The path-traversal guard
// (Finding #2) lives in safeMediaPath, enforced by the store's url()/get() at this trust boundary.
import type { RequestHandler } from '@sveltejs/kit';
import { safeMediaPath } from '$server/media/local-files';
import { getApp } from '$server/app';

const CONTENT_TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	webm: 'video/webm',
	m4a: 'audio/mp4',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	json: 'application/json' // aligned-lyrics artifacts (M7-C8)
};

export const GET: RequestHandler = async ({ params }) => {
	const ref = params.path ?? '';
	// the guard rejects traversal / absolute / NUL / .thumbs before we hit the store
	if (!safeMediaPath(ref)) return new Response('not found', { status: 404 });

	const stream = await getApp().mediaStore.get(ref);
	if (!stream) return new Response('not found', { status: 404 });

	const ext = ref.split('.').pop()?.toLowerCase() ?? '';
	return new Response(stream, {
		headers: {
			'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
			// library/stems files are immutable content addressed by name; cache hard
			'cache-control': 'public, max-age=86400'
		}
	});
};
