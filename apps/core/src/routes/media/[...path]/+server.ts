// GET /media/<sourceRef> — serve a local library/stems file from MEDIA_DIR, with a hard
// path-traversal guard (Finding #2). sourceRef is server-set today but M7 stems + the
// search-materialize path feed it, so the guard is enforced here at the trust boundary.
import type { RequestHandler } from '@sveltejs/kit';
import { safeMediaPath } from '$server/media/local-files';

const CONTENT_TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	webm: 'video/webm',
	m4a: 'audio/mp4',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	wav: 'audio/wav'
};

export const GET: RequestHandler = async ({ params }) => {
	const abs = safeMediaPath(params.path ?? '');
	if (!abs) return new Response('not found', { status: 404 }); // traversal / bad ref → 404, not 403

	const file = Bun.file(abs);
	if (!(await file.exists())) return new Response('not found', { status: 404 });

	const ext = abs.split('.').pop()?.toLowerCase() ?? '';
	return new Response(file, {
		headers: {
			'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
			// library files are immutable content addressed by name; cache hard
			'cache-control': 'public, max-age=86400'
		}
	});
};
