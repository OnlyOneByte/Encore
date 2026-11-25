// Local media file serving — resolves a media ref to an absolute path inside the storage class that
// ref belongs to, with a hard path-traversal guard (the single source of truth, shared by the
// /media route and its regression test, so "what's safe to serve" cannot drift between them). A
// ref's FIRST SEGMENT selects its storage root, so classes can live on separate volumes — the
// containment check is PER-ROOT, since a class dir may be pointed outside the media root.

import { dirname, resolve, join, sep } from 'node:path';
import { mediaRoot, resolveBase, metaDir, derivedDir } from './paths';
import { isTokenDir, workerTokenFile } from '../jobs/worker-token';
import { realPath } from '../real-path';
import { DB_FILE, dataDir } from '../db';

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
	// Nor core's own state (#1213): the database and token by name always; DATA_DIR and auth/ whole only when strictly
	// inside the root, or every song hides. Plain and real paths, case-folded for a case-insensitive volume (macOS).
	// Upper then lower: lowercasing alone leaves ſ and ı, which a case-insensitive volume matches to s and i.
	const forms = (p: string) => [p, realPath(p) ?? p].map((f) => f.toUpperCase().toLowerCase());
	const paths = forms(candidate).concat(forms(real));
	const roots = forms(base);
	const inside = (dir: string) => forms(dir).some((d) => roots.some((r) => d !== r && under(d, r)));
	const data = resolve(dataDir());
	const tokenFile = workerTokenFile();
	const tokenDir = dirname(tokenFile);
	const dirs = [metaDir(), join(mediaRoot(), '.thumbs'), join(derivedDir(), 'thumbs')];
	if (inside(data)) dirs.push(data);
	if (isTokenDir(tokenDir) && inside(tokenDir)) dirs.push(tokenDir);
	if (dirs.some((dir) => forms(dir).some((d) => paths.some((p) => under(p, d))))) return null;
	// A file and its siblings by suffix: the token's `.tmp-` half-writes, the database's -wal, -shm and -journal.
	const files = [join(data, DB_FILE), tokenFile];
	const family = (p: string, f: string) => p === f || p.startsWith(`${f}.`) || p.startsWith(`${f}-`);
	if (files.some((file) => forms(file).some((f) => paths.some((p) => family(p, f))))) return null;

	return candidate;
}
