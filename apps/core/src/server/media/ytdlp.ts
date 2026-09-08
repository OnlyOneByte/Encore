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
	} catch (err) {
		// #767 §3: an UNBOUND catch here is the whole reason "why is YouTube search empty?" is
		// answerable only from docs/HANDOFF.md:68 ("yt-dlp is invoked by name via PATH, so that
		// directory must be on PATH or YouTube search silently returns empty"). Bind the reason and
		// warn, the shape this directory already adopted for the same defect class (retention.ts:277,
		// sidecar.ts:343). The degrade itself is UNCHANGED — a missing binary still yields [], never a
		// throw (file header) — it is now merely attributable. Re-warns at most once per NEGATIVE_TTL_MS.
		console.warn('[ytdlp] availability probe failed; YouTube search will degrade to empty:', err);
		_available = false;
	}
	if (_available === false) _negativeCheckedAt = now();
	return _available;
}

const SEARCH_TIMEOUT_MS = 10_000; // Finding #5c: a hung yt-dlp must not hold the request open

/**
 * Injectable seams for `ytDlpSearch`, so each of its exits is reachable from a test (#767). Before
 * this, the function took no dependencies at all, which is why its only test could assert nothing
 * beyond `Array.isArray` on whatever the real binary happened to return.
 */
export interface YtDlpSearchDeps {
	/** The spawner, threaded into BOTH the availability probe and the search itself. */
	spawn?: typeof Bun.spawn;
	/**
	 * The availability probe. Injectable because its POSITIVE answer is cached for the process
	 * lifetime on purpose (see `ytDlpAvailable`), so a test cannot otherwise choose the answer.
	 */
	available?: (spawn?: typeof Bun.spawn) => Promise<boolean>;
	/** The kill budget. Injectable so the timeout path is provable inside a test's own budget. */
	timeoutMs?: number;
}

/**
 * YtSearchBackend: run `yt-dlp ytsearchN:<query> --dump-json --flat-playlist`.
 *
 * ATTRIBUTABLE EMPTY (#767). The graceful degrade is deliberately UNCHANGED — an absent yt-dlp still
 * yields `[]` rather than throwing (file header, docs/HANDOFF.md:68). What changes is that an empty
 * page is no longer anonymous:
 *
 *  - a KILLED search is reported, because the timeout is now owned by the shared `runCapturing`
 *    boundary (`spawn-capture.ts`, extracted from this very function by #446 and never folded back
 *    in) instead of a hand-rolled `setTimeout(kill)` that discarded its own `timedOut`. That mattered
 *    because `parseSearchJson` silently drops the truncated trailing line of a killed run, so a
 *    killed search was byte-indistinguishable from a complete short one — and `YouTubeResolver` then
 *    caches that partial page for 5 minutes (`youtube.ts:26,43`);
 *  - a NON-ZERO exit is reported with its stderr, which the old body discarded twice over (it never
 *    read `exitCode`, and it spawned with `stderr: 'ignore'`);
 *  - a spawn that CANNOT START is reported instead of escaping the function: `Bun.spawn` throws
 *    synchronously on an absent binary, and the old spawn sat OUTSIDE its own `try`, so with a
 *    positive availability probe cached forever that throw left this file entirely and surfaced as a
 *    bare `[]` from the route's catch, with no log line anywhere on the path;
 *  - a genuinely EMPTY result set stays silent, which is what makes the lines above informative.
 */
export async function ytDlpSearch(query: string, limit: number, deps: YtDlpSearchDeps = {}): Promise<SearchResult[]> {
	const spawn = deps.spawn ?? Bun.spawn;
	const available = deps.available ?? ytDlpAvailable;
	const timeoutMs = deps.timeoutMs ?? SEARCH_TIMEOUT_MS;
	if (!(await available(spawn))) return []; // graceful degrade — unchanged; the probe logs the reason
	// query is passed as a single argv element (not shell-interpolated) so it can't inject flags
	// or commands; ytsearchN: treats the remainder as a literal search string.
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
