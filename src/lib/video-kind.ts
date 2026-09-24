/* What KIND of video a search hit is, guessed from its title, and whether its duration is plausible for a song. A
   HEURISTIC over a title someone else wrote: `unknown` is a first-class answer and must never be read as "this is a
   studio recording". Separate from the server's track-title normaliser, which STRIPS these markers for LOOKUPS. */

import { formatHms } from '$lib/clock';

/** The kinds, in the order a picker cares about them. `suspect` is not "bad" but "probably not a performance of the
 * song" — a trailer sits in an ordinary song duration on a verified channel. */
export type VideoKind = 'suspect' | 'live' | 'lyric' | 'official' | 'unknown';

/* Matched case-insensitively and WORD-BOUNDED, because a bare substring over-matches ("live" is inside "delivery").
   THE ORDER OF PRECEDENCE IS THE POINT OF THIS MODULE and its tests assert it: `suspect` first because a trailer
   title frequently also says "Official"; `live` above `lyric` because live identifies a DIFFERENT RECORDING;
   `official` last, because it is the weakest claim — every aggregator channel puts it in a title. */
const SUSPECT = [
	'trailer',
	'teaser',
	'interview',
	'reaction',
	'behind the scenes',
	'making of',
	'documentary',
	'movie clip',
	'tutorial',
	'how to play',
	'announcement'
];

const LIVE = ['live aid', 'live at', 'live in', 'live from', 'live on', 'concert', 'in concert', 'unplugged', 'tour'];

const LYRIC = ['lyrics', 'lyric', 'letra', 'sub español', 'subtitulada', 'with lyrics', 'karaoke version'];

const OFFICIAL = [
	'official video',
	'official music video',
	'official audio',
	'official visualizer',
	'official hd video'
];

/** One word-bounded, case-insensitive alternation per list, built once at module load. Each alternative is ESCAPED
 * individually: a regex metacharacter appearing in the vocabulary later must not silently change the pattern. */
function compileTerms(terms: readonly string[]): RegExp {
	const body = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	return new RegExp(`(^|[^a-z0-9])(?:${body})([^a-z0-9]|$)`, 'i');
}

/** A bracketed "(Live)" marker, the common form that carries no venue. It must stay SEPARATE from the LIVE
 * vocabulary: unqualified `live` as a free word is far too loose to match on its own. */
const BARE_LIVE = /[([]\s*live\b[^)\]]*[)\]]/i;

const SUSPECT_RE = compileTerms(SUSPECT);
const LIVE_RE = compileTerms(LIVE);
const LYRIC_RE = compileTerms(LYRIC);
const OFFICIAL_RE = compileTerms(OFFICIAL);

/** Guess which kind of upload a title describes. `unknown` when nothing is recognised — never a lie. */
export function classifyVideoKind(title: string): VideoKind {
	const t = title ?? '';
	if (SUSPECT_RE.test(t)) return 'suspect';
	if (BARE_LIVE.test(t) || LIVE_RE.test(t)) return 'live';
	if (LYRIC_RE.test(t)) return 'lyric';
	if (OFFICIAL_RE.test(t)) return 'official';
	return 'unknown';
}

/* Statements, never questions: a question mark hedging OUR uncertainty reads as a prompt for the guest to answer. */
export const VIDEO_KIND_LABEL: Record<VideoKind, string | null> = {
	suspect: 'Not music',
	live: 'Live',
	lyric: 'Lyric video',
	official: 'Official video',
	unknown: null
};

/* DELIBERATELY a threshold rather than a parse, which is what makes it the most trustworthy signal on the row: it
   cannot be fooled by how someone titled their upload. The upper bound sits above the longest songs people queue, so
   it flags the odd genuine epic — the right way to be wrong, since it invites a look rather than hiding a result. */
export const SONG_MAX_SEC = 8 * 60;
export const SONG_MIN_SEC = 75;

/** A hint to read the row, never a reason to hide it. A missing or zero duration is NOT unusual: a local file and a
 * live stream both report 0, and flagging those cries wolf on every one of them. */
export function isUnusualSongDuration(durationSec: number | undefined): boolean {
	if (!durationSec || durationSec <= 0) return false;
	return durationSec > SONG_MAX_SEC || durationSec < SONG_MIN_SEC;
}

/** The same judgement IN WORDS, because colour alone says something is wrong without saying what. Null when the
 * duration is ordinary or unknown, so no chip renders. */
export function durationHint(durationSec: number | undefined): string | null {
	if (!isUnusualSongDuration(durationSec)) return null;
	return durationSec! > SONG_MAX_SEC ? 'Longer than a song' : 'Shorter than a song';
}

/** `3:44` / `21:56` / `1:02:03`. Empty string for an absent or zero duration, so the badge can hide. ROUNDS,
 * unlike the elapsed clock's floor — a catalog length is a fact, not a position — but renders through the SAME
 * `formatHms`, so the two surfaces cannot disagree about the shape. */
export function formatDuration(durationSec: number | undefined): string {
	if (!durationSec || durationSec <= 0) return '';
	return formatHms(Math.round(durationSec));
}

/** Largest first, so the first match is the right magnitude. */
const VIEW_UNITS: readonly [number, string][] = [
	[1_000_000_000, 'B'],
	[1_000_000, 'M'],
	[1_000, 'K']
];

/** A compact view count, because the number is a TIEBREAKER rather than a datum. Empty string for undefined so the
 * chip is OMITTED rather than reading zero — genuinely no views and never learning a count must not look alike. */
export function formatViewCount(views: number | undefined): string {
	if (typeof views !== 'number' || !Number.isFinite(views) || views < 0) return '';
	for (const [scale, suffix] of VIEW_UNITS) {
		if (views < scale) continue;
		const scaled = views / scale;
		// One decimal below ten, none above: 2.1B reads better than 2B, and 306M better than 305.9M.
		return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}${suffix}`;
	}
	// Below the smallest unit the count reads as itself.
	return String(Math.round(views));
}
