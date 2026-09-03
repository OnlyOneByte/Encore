// Local media file serving — resolves a media ref to an absolute path inside the storage class that
// ref belongs to, with a hard path-traversal guard. The guard is the single source of truth, imported
// by both the /media route and its regression test (same discipline as the resume.pdf PUBLIC_SECTIONS
// allowlist — never let "what's safe to serve" drift between the route and the test).
//
// A ref's FIRST SEGMENT now selects its storage root ("audio/…", "derived/…", "meta/…"), so
// the classes can live on separate volumes while refs stay portable relative strings. The containment
// check is per-root — it is NOT enough to check against the media root once, because a class dir may
// be pointed outside it.

import { resolve, join, sep } from 'node:path';
import { mediaRoot, resolveBase, metaDir, derivedDir } from './paths';

/** The media root. Kept for callers that legitimately want the root itself. */
export function mediaDir(): string {
	return mediaRoot();
}

/**
 * Resolve a request path segment (e.g. "derived/stems/x.wav", "library/song.mp4") to an absolute
 * path that is PROVABLY inside that ref's storage class root, or null if it escapes. Defeats `../`,
 * absolute paths, URL-encoded traversal, NUL, and sibling-prefix escapes (`/media-evil`).
 * Returns null (caller → 404) rather than throwing.
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

	const { base, rest } = resolveBase(decoded);
	const candidate = resolve(join(base, rest));
	// must be base itself's child: prefix check with a trailing separator so /media-evil can't pass
	if (candidate !== base && !candidate.startsWith(base + sep)) return null;

	// Never serve caches or the authoritative sidecar records through the public media route.
	// `meta/` is excluded because it is the library's source of truth, not media to stream — and it
	// carries the raw uploader metadata we deliberately retain.
	if (candidate === metaDir() || candidate.startsWith(metaDir() + sep)) return null;
	const legacyThumbs = join(mediaRoot(), '.thumbs');
	if (candidate === legacyThumbs || candidate.startsWith(legacyThumbs + sep)) return null;
	const thumbs = join(derivedDir(), 'thumbs');
	if (candidate === thumbs || candidate.startsWith(thumbs + sep)) return null;

	return candidate;
}
