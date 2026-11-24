// Local media file serving — resolves a media ref to an absolute path inside the storage class that
// ref belongs to, with a hard path-traversal guard (the single source of truth, shared by the
// /media route and its regression test, so "what's safe to serve" cannot drift between them). A
// ref's FIRST SEGMENT selects its storage root, so classes can live on separate volumes — the
// containment check is PER-ROOT, since a class dir may be pointed outside the media root.

import { dirname, resolve, join, sep } from 'node:path';
import { mediaRoot, resolveBase, metaDir, derivedDir } from './paths';
import { isTokenDir, workerTokenFile } from '../jobs/worker-token';
import { realPath } from '../real-path';

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/**
 * Resolve a ref to an absolute path PROVABLY inside that ref's storage class root, or null if it
 * escapes — defeats `../`, absolute paths, URL-encoded traversal, NUL, sibling-prefix escapes
 * (`/media-evil`) and symlinks that lead out. Returns null (caller → 404) rather than throwing.
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
	// No media ref is a dot-file, so none is served: caches (.thumbs), AppleDouble files (._x), stray secrets.
	if (decoded.split(/[/\\]/).some((segment) => segment.startsWith('.'))) return null;

	const { base, rest } = resolveBase(decoded);
	const candidate = resolve(join(base, rest));
	// must be base itself's child: prefix check with a trailing separator so /media-evil can't pass
	if (!under(candidate, base)) return null;
	// Real paths too, or a link planted under media serves any file core can read (#1206). A class root that is
	// itself a link or a mount still works, because both sides are resolved.
	const real = realPath(candidate);
	const realBase = realPath(base);
	if (!real || !realBase || !under(real, realBase)) return null;

	// Never serve caches or the authoritative sidecar records through the public media route. `meta/`
	// is the library's source of truth, not media to stream — and carries retained raw uploader metadata.
	const hidden = [metaDir(), join(mediaRoot(), '.thumbs'), join(derivedDir(), 'thumbs')];
	for (const dir of hidden) {
		const realDir = realPath(dir) ?? dir;
		if (under(candidate, dir) || under(real, dir) || under(real, realDir)) return null;
	}
	// Never the worker token, its temp files, or its own auth/ dir (a hand-set file's dir may hold media), compared
	// by real path both ways so a linked MEDIA_DIR or DATA_DIR cannot alias them back in.
	const tokenFile = workerTokenFile();
	const tokenDir = dirname(tokenFile);
	const paths = [candidate, real];
	const files = [tokenFile, realPath(tokenFile) ?? tokenFile];
	if (paths.some((p) => files.some((f) => p === f || p.startsWith(`${f}.tmp-`)))) return null;
	const dirs = isTokenDir(tokenDir) ? [tokenDir, realPath(tokenDir) ?? tokenDir] : [];
	if (paths.some((p) => dirs.some((d) => under(p, d)))) return null;

	return candidate;
}
