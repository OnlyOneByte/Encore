/*
 * What KIND of video a search hit is, guessed from its title — and whether its duration is plausible
 * for a song at all.
 *
 * WHY THIS EXISTS. A YouTube search for one song returns the official video, three lyric videos, a
 * live cut, a movie trailer and a 22-minute concert rip, and the singer has to pick. The single most
 * decision-relevant token is the version marker at the END of the title — "(Official Video)",
 * "(Lyrics)", "(Live Aid 1985)" — which is exactly the part a one-line ellipsised row truncates away.
 * Promoting it to a labelled chip puts it where it cannot be cut off.
 *
 * This is a HEURISTIC over a title someone else wrote, and it says so: `unknown` is a first-class
 * answer, returned whenever no marker is recognised. It must never be read as "this is a studio
 * recording" — only as "nothing in the title claimed otherwise".
 *
 * SEPARATE from track-title.ts on purpose. That module answers "what song is this?" for LOOKUPS
 * (MusicBrainz, LRCLIB) and lives server-side; this one answers "which upload am I looking at?" for
 * DISPLAY and is needed by the phone, so it lives in the shared contract. They share a vocabulary
 * problem but not a purpose: track-title.ts STRIPS these markers to recover a clean song name, while
 * this module's whole job is to keep them.
 *
 * PURE: no network, no I/O, no clock.
 */

/**
 * The kinds, in the order a picker cares about them.
 *
 * `suspect` is not "bad", it is "probably not a performance of the song" — a trailer, an interview, a
 * reaction. It exists because those uploads are otherwise indistinguishable from a song at a glance:
 * the 2:31 "Bohemian Rhapsody | Official Trailer [HD]" sits in a perfectly ordinary song duration and
 * is published by a verified channel.
 */
export type VideoKind = 'suspect' | 'live' | 'lyric' | 'official' | 'unknown';

/*
 * Vocabulary. Matched case-insensitively against the whole title, word-bounded where a bare substring
 * would over-match ("live" is inside "delivery", "Olive", "Living").
 *
 * ORDER OF PRECEDENCE is the point of this module and is asserted by its tests:
 *
 *   suspect > live > lyric > official
 *
 *   - `suspect` first because a trailer title frequently ALSO says "Official" ("Official Trailer"),
 *     and labelling a movie trailer "Official video" is worse than saying nothing at all.
 *   - `live` above `lyric` because live identifies a DIFFERENT RECORDING — different arrangement,
 *     length and often key — whereas `lyric` only describes what is drawn on screen. This mirrors the
 *     rule track-title.ts already follows when it refuses to strip "(Live)" as noise.
 *   - `official` last: it is the weakest claim of the four, because "official" is the word every
 *     aggregator channel puts in a title.
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
 * Compile a vocabulary list into ONE word-bounded, case-insensitive alternation, built once at module
 * load instead of a fresh RegExp per term per title. `TERMS.some((t) => hasTerm(title, t))` and a
 * single `(^|[^a-z0-9])(term1|term2|…)([^a-z0-9]|$)` are equivalent for `.test()` — the boundary
 * wrappers are identical and the body is a disjunction — so this is a pure precompute, not a rule
 * change. Each alternative is escaped individually: the vocabulary is our own literals today, but a
 * regex metacharacter appearing in one later must not silently change what the pattern means.
 */
function compileTerms(terms: readonly string[]): RegExp {
	const body = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	return new RegExp(`(^|[^a-z0-9])(?:${body})([^a-z0-9]|$)`, 'i');
}

/**
 * A bare "(Live)" / "[Live]" marker — the common form that carries no venue. Kept separate from the
 * LIVE vocabulary because unqualified `live` as a free word is far too loose to match on its own
 * ("Live Your Life", "Livin' on a Prayer" survive only because of the parenthesis requirement).
 */
const BARE_LIVE = /[([]\s*live\b[^)\]]*[)\]]/i;

// Precompiled once at module load — see compileTerms. The precedence order (suspect > live > lyric >
// official) is unchanged and remains the point of this module, asserted by its tests.
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

/*
 * "Not music", not "Not a song?".
 *
 * A first-time guest reading the old label said it was "phrased as a question to me, which is
 * bizarre — am I being asked?". It was: a question mark hedging OUR uncertainty looked like a prompt
 * for the guest to answer. The hedge belongs in this comment, not on the chip.
 */
export const VIDEO_KIND_LABEL: Record<VideoKind, string | null> = {
	suspect: 'Not music',
	live: 'Live',
	lyric: 'Lyric video',
	official: 'Official video',
	unknown: null
};

/*
 * Duration bounds for "plausibly one song".
 *
 * DELIBERATELY a threshold and not a parse, which is what makes it the most trustworthy signal on the
 * row: it cannot be fooled by how someone titled their upload. 8 minutes is above the longest songs
 * people actually queue (Bohemian Rhapsody is 6:00, American Pie 8:33 — so this will flag the odd
 * genuine epic, which is the right way to be wrong: it invites a look rather than hiding a result).
 * 75 seconds is below any full performance and catches clips, intros and previews.
 */
export const SONG_MAX_SEC = 8 * 60;
export const SONG_MIN_SEC = 75;

/**
 * Is this duration outside the range a single song occupies? Used to draw the duration badge in a
 * warning colour — a hint to read the row, never a reason to hide it.
 *
 * A missing or zero duration is NOT unusual: local library files and a yt-dlp result for a live
 * stream both report 0, and colouring those as suspect would cry wolf on every one of them.
 */
export function isUnusualSongDuration(durationSec: number | undefined): boolean {
	if (!durationSec || durationSec <= 0) return false;
	return durationSec > SONG_MAX_SEC || durationSec < SONG_MIN_SEC;
}

/**
 * The same judgement IN WORDS, for a chip beside the badge.
 *
 * Exists because a first-time guest reviewing this screen read the red 21:56 badge as "a red badge
 * you don't understand" — the colour said something was wrong without saying what, which is worse
 * than staying quiet. The most trustworthy signal on the row was the least legible one. Null when the
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
 * `2.1B` / `306M` / `3.1M` / `266K` / `981`.
 *
 * Compact because the number is a TIEBREAKER, not a datum: between two lyric uploads of one song,
 * 2.1B vs 266K settles which is the canonical one, and no one needs the remaining eight digits to
 * make that call. Returns '' for undefined so the chip can be omitted rather than reading "0 views"
 * — a song with genuinely no view count and a song we never learned one for must not look alike.
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
			// One decimal below 10 (2.1B reads better than 2B), none above (306M, not 305.9M).
			return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}${suffix}`;
		}
	}
	return String(Math.round(views));
}
