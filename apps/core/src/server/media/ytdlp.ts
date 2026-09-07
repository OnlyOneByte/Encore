// yt-dlp backend — keyless YouTube search + metadata via the yt-dlp binary (Bun.spawn).
// Graceful degradation: if yt-dlp isn't installed (common in dev), search returns [] rather
// than throwing, so the app still runs (local library + demo catalog remain usable).
//
// The pure parser (parseSearchJson / parseMetaJson) is separated so it unit-tests without the
// binary. `ytDlpSearch` is the YtSearchBackend wired into YouTubeResolver in prod.

import type { SearchResult } from './resolver';
import { runCapturing } from './spawn-capture';

/**
 * The thumbnail URL for a YouTube video id, DERIVED rather than taken from yt-dlp's `thumbnails[]`.
 *
 * Three reasons, all measured against yt-dlp 2026.08.19:
 *
 *  1. INCONSISTENT ASPECT. `thumbnails[].at(-1)` is whatever the extractor happened to list last, and
 *     that varies by result set: a `ytsearch3` returned `hq720.jpg` (720×404, 16:9) while a
 *     `ytsearch1` for the same video returned `hqdefault.jpg` — which is 4:3 and therefore
 *     letterboxed with black bars inside a 16:9 slot. One row would have bars and its neighbour none.
 *  2. WRONG SIZE. The largest listed variant is 720px wide, ~13× the pixels an 84px row thumbnail
 *     needs. `mqdefault` is 320×180 — right for the slot at 2–3× DPR, and a fraction of the bytes on
 *     the phone's wifi.
 *  3. UNSIGNED, THEREFORE CACHEABLE FOREVER. The listed URLs carry `?sqp=…&rs=…` signature
 *     parameters. The proxy's disk cache keys on the whole URL (see thumbs.ts `thumbKey`), so any
 *     change in those parameters silently writes a second copy of the same image. The bare
 *     `mqdefault.jpg` form has no query string at all, so one video is one cache entry for good.
 *
 * `i.ytimg.com` is already on the proxy's SSRF host allowlist, and every YouTube video has an
 * `mqdefault`, so this needs no fallback.
 */
export function ytThumbnailUrl(videoId: string): string {
	return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
}

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
				thumbnail: ytThumbnailUrl(j.id),
				// `view_count` IS present in --flat-playlist output (measured), unlike `upload_date` and
				// `release_timestamp`, which are null there and would each cost a per-video metadata call.
				// Guarded on the type because a non-number would render as "NaN views".
				viewCount: typeof j.view_count === 'number' && Number.isFinite(j.view_count) ? j.view_count : undefined
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
const AVAILABLE_TIMEOUT_MS = 5_000; // Finding #5c sibling: a hung `yt-dlp --version` must not wedge boot.
export async function ytDlpAvailable(spawn = Bun.spawn, now: () => number = Date.now): Promise<boolean> {
	if (_available === true) return true;
	if (_available === false && now() - _negativeCheckedAt < NEGATIVE_TTL_MS) return false;
	try {
		// Timed: a `--version` that hangs (a wedged binary, a stuck NFS mount) would otherwise leave the
		// probe awaiting forever and take every search caller with it. A timeout reads as unavailable.
		const r = await runCapturing(['yt-dlp', '--version'], AVAILABLE_TIMEOUT_MS, spawn);
		_available = !r.timedOut && r.code === 0;
	} catch {
		_available = false;
	}
	if (_available === false) _negativeCheckedAt = now();
	return _available;
}

const SEARCH_TIMEOUT_MS = 10_000; // Finding #5c: a hung yt-dlp must not hold the request open

/** YtSearchBackend: run `yt-dlp ytsearchN:<query> --dump-json --flat-playlist`. */
export async function ytDlpSearch(query: string, limit: number): Promise<SearchResult[]> {
	if (!(await ytDlpAvailable())) return []; // graceful degrade
	// query is passed as a single argv element (not shell-interpolated) so it can't inject flags
	// or commands; ytsearchN: treats the remainder as a literal search string.
	const proc = Bun.spawn(['yt-dlp', `ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist', '--no-warnings'], {
		stdout: 'pipe',
		stderr: 'ignore'
	});
	const killer = setTimeout(() => proc.kill(), SEARCH_TIMEOUT_MS);
	try {
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		const results = parseSearchJson(text);
		return results;
	} catch {
		return [];
	} finally {
		clearTimeout(killer);
	}
}
