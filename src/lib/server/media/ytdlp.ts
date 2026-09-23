// yt-dlp backend — keyless YouTube search + metadata via the yt-dlp binary (Bun.spawn). Graceful
// degradation: an absent yt-dlp (common in dev) makes search return [] rather than throw, so the
// local library + demo catalog stay usable. The parser is pure and separated so it unit-tests
// without the binary; `ytDlpSearch` is the YtSearchBackend wired into YouTubeResolver in prod.

import type { SearchResult } from './resolver';
import { runCapturing } from './spawn-capture';

/**
 * The thumbnail URL for a YouTube video id, DERIVED rather than taken from yt-dlp's `thumbnails[]`:
 * that list's aspect ratio and size vary by result set, and its URLs carry signature query params
 * that defeat the proxy's URL-keyed disk cache (thumbs.ts `thumbKey`) with duplicate copies. The bare
 * `mqdefault.jpg` form is a fixed, query-string-free 320×180 that every YouTube video has.
 * `i.ytimg.com` is already on the proxy's SSRF host allowlist (docs/ARCHITECTURE.md §10).
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

// Availability probe: cache only a POSITIVE result forever; re-probe after a TTL when negative, so
// yt-dlp installed after boot — or a racey first probe — doesn't disable search until restart.
let _available: boolean | null = null;
let _negativeCheckedAt = 0;
const NEGATIVE_TTL_MS = 60_000;
const AVAILABLE_TIMEOUT_MS = 5_000; // a hung `yt-dlp --version` must not wedge boot
export async function ytDlpAvailable(spawn = Bun.spawn, now: () => number = Date.now): Promise<boolean> {
	if (_available === true) return true;
	if (_available === false && now() - _negativeCheckedAt < NEGATIVE_TTL_MS) return false;
	try {
		// A wedged binary or stuck mount must not hang the probe (and every caller waiting on it) forever.
		const r = await runCapturing(['yt-dlp', '--version'], AVAILABLE_TIMEOUT_MS, spawn);
		_available = !r.timedOut && r.code === 0;
	} catch (err) {
		// yt-dlp is invoked by name via PATH, so a missing PATH entry lands here — bind and log the
		// reason rather than swallowing it, so an empty search result is attributable. The degrade
		// itself is unchanged: still [], never a throw.
		console.warn('[ytdlp] availability probe failed; YouTube search will degrade to empty:', err);
		_available = false;
	}
	if (_available === false) _negativeCheckedAt = now();
	return _available;
}

const SEARCH_TIMEOUT_MS = 10_000; // a hung yt-dlp must not hold the request open

/** Injectable seams for `ytDlpSearch`, so each of its exits is reachable from a test. */
export interface YtDlpSearchDeps {
	/** Threaded into BOTH the availability probe and the search itself. */
	spawn?: typeof Bun.spawn;
	/** Injectable because a POSITIVE answer is cached for the process lifetime (see `ytDlpAvailable`). */
	available?: (spawn?: typeof Bun.spawn) => Promise<boolean>;
	/** The kill budget. Injectable so the timeout path is provable inside a test's own budget. */
	timeoutMs?: number;
}

/**
 * YtSearchBackend: run `yt-dlp ytsearchN:<query> --dump-json --flat-playlist`. An absent yt-dlp still
 * yields `[]` rather than throwing, but every other empty is now attributable rather than silent: a
 * KILLED search is reported (a killed run's truncated trailing line is silently dropped by
 * `parseSearchJson`, so it would otherwise be indistinguishable from a complete short page, and
 * `YouTubeResolver` caches that partial page for 5 minutes); a NON-ZERO exit is reported with stderr;
 * a spawn that cannot start is reported instead of escaping the function. Only a genuinely empty
 * result set stays silent.
 */
export async function ytDlpSearch(query: string, limit: number, deps: YtDlpSearchDeps = {}): Promise<SearchResult[]> {
	const spawn = deps.spawn ?? Bun.spawn;
	const available = deps.available ?? ytDlpAvailable;
	const timeoutMs = deps.timeoutMs ?? SEARCH_TIMEOUT_MS;
	if (!(await available(spawn))) return []; // graceful degrade; the probe already logged the reason
	// query is one argv element, never shell-interpolated — see docs/ARCHITECTURE.md §10.
	const argv = ['yt-dlp', `ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist', '--no-warnings'];
	try {
		// The spawn is INSIDE the try because it is runCapturing's, not ours.
		const r = await runCapturing(argv, timeoutMs, spawn);
		const results = parseSearchJson(r.stdout);
		// The query is JSON-quoted so a newline in it cannot forge a second log line.
		if (r.timedOut) {
			console.warn(
				`[ytdlp] search for ${JSON.stringify(query)} was KILLED after ${timeoutMs}ms; returning the ${results.length} result(s) that had arrived (the page may be truncated)`
			);
		} else if (r.code !== 0) {
			console.warn(
				`[ytdlp] search for ${JSON.stringify(query)} exited ${r.code} with ${results.length} result(s); stderr: ${r.stderr.trim().slice(0, 400)}`
			);
		}
		return results;
	} catch (err) {
		console.warn('[ytdlp] search could not spawn despite a positive availability probe:', err);
		return [];
	}
}
