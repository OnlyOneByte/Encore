/*
 * What KIND of video a search hit is, guessed from its title, and whether its duration is plausible for a
 * song at all. PURE: no network, no I/O, no clock.
 *
 * A HEURISTIC over a title someone else wrote, and it says so: `unknown` is a first-class answer and must
 * never be read as "this is a studio recording", only as "nothing in the title claimed otherwise".
 *
 * Deliberately separate from the server's track-title normaliser, which STRIPS these markers to recover a
 * clean name for LOOKUPS. This module's whole job is to keep them, for DISPLAY.
 */

/**
 * The kinds, in the order a picker cares about them. `suspect` is not "bad", it is "probably not a
 * performance of the song" — a trailer or an interview is otherwise indistinguishable from a song at a
 * glance, since it sits in an ordinary song duration on a verified channel.
 */
export type VideoKind = 'suspect' | 'live' | 'lyric' | 'official' | 'unknown';

/*
 * Vocabulary, matched case-insensitively and WORD-BOUNDED, because a bare substring over-matches ("live" is
 * inside "delivery" and "Olive").
 *
 * THE ORDER OF PRECEDENCE IS THE POINT OF THIS MODULE and its tests assert it: suspect, then live, then
 * lyric, then official. `suspect` first because a trailer title frequently also says "Official", and calling
 * a trailer an official video is worse than saying nothing. `live` above `lyric` because live identifies a
 * DIFFERENT RECORDING — arrangement, length, often key — while `lyric` only describes what is on screen.
 * `official` last, because it is the weakest claim: every aggregator channel puts it in a title.
 */
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

/**
 * One word-bounded, case-insensitive alternation per list, built once at module load rather than a fresh
 * RegExp per term per title. Each alternative is ESCAPED individually: the vocabulary is our own literals
 * today, but a regex metacharacter appearing in one later must not silently change what the pattern means.
 */
function compileTerms(terms: readonly string[]): RegExp {
	const body = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	return new RegExp(`(^|[^a-z0-9])(?:${body})([^a-z0-9]|$)`, 'i');
}

/**
 * A bracketed "(Live)" marker, the common form that carries no venue. It must stay SEPARATE from the LIVE
 * vocabulary: unqualified `live` as a free word is far too loose to match on its own, and song titles
 * containing it survive only because of the bracket requirement.
 */
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

/* Statements, never questions: a question mark hedging OUR uncertainty reads as a prompt for the guest to
   answer. The hedge belongs in this module's own note, not on a chip. */
export const VIDEO_KIND_LABEL: Record<VideoKind, string | null> = {
	suspect: 'Not music',
	live: 'Live',
	lyric: 'Lyric video',
	official: 'Official video',
	unknown: null
};

/*
 * Duration bounds for "plausibly one song" — DELIBERATELY a threshold rather than a parse, which is what
 * makes it the most trustworthy signal on the row: it cannot be fooled by how someone titled their upload.
 * The upper bound sits above the longest songs people queue, so it flags the odd genuine epic, which is the
 * right way to be wrong — it invites a look rather than hiding a result.
 */
export const SONG_MAX_SEC = 8 * 60;
export const SONG_MIN_SEC = 75;

/**
 * Is this duration outside the range a single song occupies? A hint to read the row, never a reason to hide
 * it. A missing or zero duration is NOT unusual: a local file and a live stream both report 0, and flagging
 * those cries wolf on every one of them.
 */
export function isUnusualSongDuration(durationSec: number | undefined): boolean {
	if (!durationSec || durationSec <= 0) return false;
	return durationSec > SONG_MAX_SEC || durationSec < SONG_MIN_SEC;
}

/**
 * The same judgement IN WORDS, because colour alone says something is wrong without saying what — which is
 * worse than staying quiet, and left the row's most trustworthy signal its least legible one. Null when the
 * duration is ordinary or unknown, so no chip renders.
 */
export function durationHint(durationSec: number | undefined): string | null {
	if (!isUnusualSongDuration(durationSec)) return null;
	return durationSec! > SONG_MAX_SEC ? 'Longer than a song' : 'Shorter than a song';
}

/** `3:44` / `21:56` / `1:02:03`. Empty string for an absent or zero duration, so the badge can hide. */
export function formatDuration(durationSec: number | undefined): string {
	if (!durationSec || durationSec <= 0) return '';
	const total = Math.round(durationSec);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
	return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * A compact view count, because the number is a TIEBREAKER rather than a datum: between two uploads of one
 * song the magnitude settles which is canonical, and nobody needs the remaining digits. Empty string for
 * undefined so the chip is OMITTED rather than reading zero — a song with genuinely no views and a song we
 * never learned a count for must not look alike.
 */
export function formatViewCount(views: number | undefined): string {
	if (views === undefined || views === null || !Number.isFinite(views) || views < 0) return '';
	if (views < 1000) return String(Math.round(views));
	const units: Array<[number, string]> = [
		[1_000_000_000, 'B'],
		[1_000_000, 'M'],
		[1_000, 'K']
	];
	for (const [scale, suffix] of units) {
		if (views >= scale) {
			const scaled = views / scale;
			// One decimal below ten, none above: 2.1B reads better than 2B, and 306M better than 305.9M.
			return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}${suffix}`;
		}
	}
	return String(Math.round(views));
}
