// Keyless YouTube search via the yt-dlp binary. An absent yt-dlp makes search return [] rather than throw,
// so the local library stays usable. The parser is pure and separate, so it unit-tests without the binary.

import type { SearchResult } from './resolver';
import { runCapturing } from './spawn-capture';

/**
 * DERIVED rather than taken from yt-dlp's `thumbnails[]`, whose aspect ratio varies by result set and whose
 * URLs carry signature query params that defeat the proxy's URL-keyed disk cache with duplicates. The bare
 * `mqdefault.jpg` form is a fixed, query-string-free 320x180 every video has, on the SSRF host allowlist.
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
				// `view_count` IS present in --flat-playlist output, unlike `upload_date`, which would cost a
				// per-video call. Type-guarded because a non-number renders as "NaN views".
				viewCount: typeof j.view_count === 'number' && Number.isFinite(j.view_count) ? j.view_count : undefined
			});
		} catch {
			// skip malformed lines
		}
	}
	return out;
}

// Only a POSITIVE result caches forever; a negative re-probes after a TTL, so yt-dlp installed after boot
// does not disable search until restart.
let _available: boolean | null = null;
let _negativeCheckedAt = 0;
const NEGATIVE_TTL_MS = 60_000;
const AVAILABLE_TIMEOUT_MS = 5_000; // a hung `yt-dlp --version` must not wedge boot
export async function ytDlpAvailable(spawn = Bun.spawn, now: () => number = Date.now): Promise<boolean> {
	if (_available === true) return true;
	if (_available === false && now() - _negativeCheckedAt < NEGATIVE_TTL_MS) return false;
	try {
		// A wedged binary must not hang the probe and every caller waiting on it.
		const r = await runCapturing(['yt-dlp', '--version'], AVAILABLE_TIMEOUT_MS, spawn);
		_available = !r.timedOut && r.code === 0;
	} catch (err) {
		// yt-dlp is invoked by name via PATH, so a missing entry lands here. Logged rather than swallowed,
		// so an empty search result is attributable; the degrade is still [], never a throw.
		console.warn('[ytdlp] availability probe failed; YouTube search will degrade to empty:', err);
		_available = false;
	}
	if (_available === false) _negativeCheckedAt = now();
	return _available;
}

const SEARCH_TIMEOUT_MS = 10_000; // a hung yt-dlp must not hold the request open

/** So each of `ytDlpSearch`'s exits is reachable from a test. */
export interface YtDlpSearchDeps {
	/** Threaded into BOTH the availability probe and the search itself. */
	spawn?: typeof Bun.spawn;
	/** Injectable because a POSITIVE answer is cached for the process lifetime (see `ytDlpAvailable`). */
	available?: (spawn?: typeof Bun.spawn) => Promise<boolean>;
	/** The kill budget. Injectable so the timeout path is provable inside a test's own budget. */
	timeoutMs?: number;
}

/**
 * An absent yt-dlp still yields `[]` rather than throwing, but every OTHER empty is attributable: a KILLED
 * search is reported, because its truncated trailing line is dropped silently and would otherwise look like a
 * complete short page that `YouTubeResolver` then caches for 5 minutes; a non-zero exit is reported with
 * stderr; a spawn that cannot start is reported rather than escaping. Only a genuinely empty set stays silent.
 */
export async function ytDlpSearch(query: string, limit: number, deps: YtDlpSearchDeps = {}): Promise<SearchResult[]> {
	const spawn = deps.spawn ?? Bun.spawn;
	const available = deps.available ?? ytDlpAvailable;
	const timeoutMs = deps.timeoutMs ?? SEARCH_TIMEOUT_MS;
	if (!(await available(spawn))) return []; // graceful degrade; the probe already logged the reason
	// query is one argv element, never shell-interpolated — see docs/ARCHITECTURE.md §10.
	const argv = ['yt-dlp', `ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist', '--no-warnings'];
	try {
		// The spawn is INSIDE the try, because it is runCapturing's and not ours.
		const r = await runCapturing(argv, timeoutMs, spawn);
		const results = parseSearchJson(r.stdout);
		// JSON-quoted, so a newline in the query cannot forge a second log line.
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
