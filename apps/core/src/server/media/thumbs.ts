// Thumbnail proxy with on-disk cache. Fetches a remote thumbnail once, stores it under the
// media cache dir, and serves subsequent hits from disk with long immutable cache headers.
// Pure cache-key + path logic is separated for unit testing.

import { createHash } from 'node:crypto';
import { join } from 'node:path';

const THUMB_DIR = () => join(process.env.MEDIA_DIR ?? './media', '.thumbs');

// SSRF guard (Finding #1): the proxy must only fetch the hosts yt-dlp actually returns for
// thumbnails. Without an allowlist, ?u=http://169.254.169.254/... turns this into a
// server-side request forgery probe of the internal network / cloud metadata endpoint.
const ALLOWED_THUMB_HOSTS = new Set([
	'i.ytimg.com',
	'i9.ytimg.com',
	'img.youtube.com',
	'yt3.ggpht.com',
	'yt3.googleusercontent.com'
]);

/** Is this URL one we're willing to proxy? https-only + host allowlist. */
export function isAllowedThumbUrl(u: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(u);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'https:') return false; // no http (SSRF to plaintext internal svcs)
	return ALLOWED_THUMB_HOSTS.has(parsed.hostname);
}

/** Stable, collision-resistant, filesystem-safe cache filename for a remote thumbnail URL. */
export function thumbKey(url: string): string {
	// SHA-256 hex (Finding #5a): deterministic across restarts + collision-resistant, unlike the
	// 64-bit seeded Bun.hash which could map two videos' thumbnails to the same cache file.
	const h = createHash('sha256').update(url).digest('hex').slice(0, 32);
	const ext = url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)?.[1]?.toLowerCase() ?? 'jpg';
	return `${h}.${ext}`;
}

export function thumbPath(url: string): string {
	return join(THUMB_DIR(), thumbKey(url));
}

const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export function contentTypeFor(key: string): string {
	const ext = key.split('.').pop() ?? 'jpg';
	return TYPES[ext] ?? 'image/jpeg';
}

const IMMUTABLE = 'public, max-age=2592000, immutable'; // 30 days
const FETCH_TIMEOUT_MS = 5000; // Finding #5c: a hung upstream must not hold the request open

/** Serve a thumbnail: from disk if cached, else fetch (allowlisted host) → cache → serve. */
export async function serveThumb(url: string): Promise<Response> {
	if (!isAllowedThumbUrl(url)) return new Response('forbidden thumbnail host', { status: 400 });
	const path = thumbPath(url);
	const cached = Bun.file(path);
	if (await cached.exists()) {
		return new Response(cached, {
			headers: { 'content-type': contentTypeFor(path), 'cache-control': IMMUTABLE, 'x-cache': 'HIT' }
		});
	}
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) return new Response('upstream error', { status: 502 });
		const bytes = await res.arrayBuffer();
		await Bun.write(path, bytes); // populate the on-disk cache
		return new Response(bytes, {
			headers: { 'content-type': res.headers.get('content-type') ?? contentTypeFor(path), 'cache-control': IMMUTABLE, 'x-cache': 'MISS' }
		});
	} catch {
		return new Response('fetch failed', { status: 502 });
	}
}
