// Local media file serving — resolves a media ref to an absolute path inside the storage class that
// ref belongs to, with a hard path-traversal guard (the single source of truth, shared by the
// /media route and its regression test, so "what's safe to serve" cannot drift between them). A
// ref's FIRST SEGMENT selects its storage root, so classes can live on separate volumes — the
// containment check is PER-ROOT, since a class dir may be pointed outside the media root.

import { resolve, join, sep } from 'node:path';
import { mediaRoot, resolveBase, metaDir, derivedDir } from './paths';

/**
 * Resolve a ref to an absolute path PROVABLY inside that ref's storage class root, or null if it
 * escapes — defeats `../`, absolute paths, URL-encoded traversal, NUL, and sibling-prefix escapes
 * (`/media-evil`). Returns null (caller → 404) rather than throwing.
 */
export function safeMediaPath(ref: string): string | null {
	if (!ref) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(ref);
	} catch {
		return null; // malformed %-encoding
	}
	if (decoded.includes('\0') || decoded.startsWith('/') || decoded.startsWith('\\')) return null;

	const { base, rest } = resolveBase(decoded);
	const candidate = resolve(join(base, rest));
	// must be base itself's child: prefix check with a trailing separator so /media-evil can't pass
	if (candidate !== base && !candidate.startsWith(base + sep)) return null;

	// Never serve caches or the authoritative sidecar records through the public media route. `meta/`
	// is the library's source of truth, not media to stream — and carries retained raw uploader metadata.
	if (candidate === metaDir() || candidate.startsWith(metaDir() + sep)) return null;
	const legacyThumbs = join(mediaRoot(), '.thumbs');
	if (candidate === legacyThumbs || candidate.startsWith(legacyThumbs + sep)) return null;
	const thumbs = join(derivedDir(), 'thumbs');
	if (candidate === thumbs || candidate.startsWith(thumbs + sep)) return null;

	return candidate;
}
