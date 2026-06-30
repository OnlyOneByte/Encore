// yt-dlp backend — keyless YouTube search + metadata via the yt-dlp binary (Bun.spawn).
// Graceful degradation: if yt-dlp isn't installed (common in dev), search returns [] rather
// than throwing, so the app still runs (local library + demo catalog remain usable).
//
// The pure parser (parseSearchJson / parseMetaJson) is separated so it unit-tests without the
// binary. `ytDlpSearch` is the YtSearchBackend wired into YouTubeResolver in prod.

import type { SearchResult } from './resolver';

// yt-dlp --dump-json emits one JSON object per line (flat playlist for ytsearch).
export function parseSearchJson(lines: string): SearchResult[] {
	const out: SearchResult[] = [];
	for (const line of lines.split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			const j = JSON.parse(t);
			if (!j.id) continue;
			out.push({
				source: 'youtube',
				sourceRef: j.id,
				title: j.title ?? j.id,
				artist: j.uploader ?? j.channel ?? undefined,
				durationSec: Math.round(j.duration ?? 0),
				thumbnail: j.thumbnail ?? (j.thumbnails?.at(-1)?.url) ?? undefined
			});
		} catch {
			// skip malformed lines
		}
	}
	return out;
}

// Availability probe: cache only a POSITIVE result forever; re-probe after a TTL when negative
// (Finding #5b) so yt-dlp installed after boot — or a racey first probe — doesn't disable search
// until restart.
let _available: boolean | null = null;
let _negativeCheckedAt = 0;
const NEGATIVE_TTL_MS = 60_000;
export async function ytDlpAvailable(spawn = Bun.spawn, now: () => number = Date.now): Promise<boolean> {
	if (_available === true) return true;
	if (_available === false && now() - _negativeCheckedAt < NEGATIVE_TTL_MS) return false;
	try {
		const proc = spawn(['yt-dlp', '--version'], { stdout: 'pipe', stderr: 'ignore' });
		await proc.exited;
		_available = proc.exitCode === 0;
	} catch {
		_available = false;
	}
	if (_available === false) _negativeCheckedAt = now();
	return _available;
}

/** Per-video-id metadata cache (resolve a video id once). */
const metaCache = new Map<string, SearchResult>();
export function cacheMeta(r: SearchResult): void {
	metaCache.set(r.sourceRef, r);
}
export function getCachedMeta(id: string): SearchResult | undefined {
	return metaCache.get(id);
}

const SEARCH_TIMEOUT_MS = 10_000; // Finding #5c: a hung yt-dlp must not hold the request open

/** YtSearchBackend: run `yt-dlp ytsearchN:<query> --dump-json --flat-playlist`. */
export async function ytDlpSearch(query: string, limit: number): Promise<SearchResult[]> {
	if (!(await ytDlpAvailable())) return []; // graceful degrade
	// query is passed as a single argv element (not shell-interpolated) so it can't inject flags
	// or commands; ytsearchN: treats the remainder as a literal search string.
	const proc = Bun.spawn(
		['yt-dlp', `ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist', '--no-warnings'],
		{ stdout: 'pipe', stderr: 'ignore' }
	);
	const killer = setTimeout(() => proc.kill(), SEARCH_TIMEOUT_MS);
	try {
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		const results = parseSearchJson(text);
		results.forEach(cacheMeta); // warm the per-id cache
		return results;
	} catch {
		return [];
	} finally {
		clearTimeout(killer);
	}
}
