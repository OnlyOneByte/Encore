// Local media file serving — resolves a Media.sourceRef to an absolute path UNDER MEDIA_DIR,
// with a hard path-traversal guard. The guard is the single source of truth, imported by both
// the /media route and its regression test (same discipline as the resume.pdf PUBLIC_SECTIONS
// allowlist — never let "what's safe to serve" drift between the route and the test).

import { join, resolve, sep } from 'node:path';

export function mediaDir(): string {
	return resolve(process.env.MEDIA_DIR ?? './media');
}

/**
 * Resolve a request path segment (e.g. "library/song.mp4") to an absolute path that is PROVABLY
 * inside MEDIA_DIR, or null if it escapes. Defeats `../`, absolute paths, URL-encoded traversal,
 * and symlink-free escapes. Returns null (caller → 404) rather than throwing.
 */
export function safeMediaPath(ref: string): string | null {
	if (!ref) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(ref);
	} catch {
		return null; // malformed %-encoding
	}
	// reject NUL and absolute paths outright
	if (decoded.includes('\0') || decoded.startsWith('/') || decoded.startsWith('\\')) return null;
	const base = mediaDir();
	const candidate = resolve(join(base, decoded));
	// must be base itself's child: prefix check with a trailing separator so /media-evil can't pass
	if (candidate !== base && !candidate.startsWith(base + sep)) return null;
	// never serve the thumb cache through the media route
	if (candidate.startsWith(join(base, '.thumbs') + sep)) return null;
	return candidate;
}
