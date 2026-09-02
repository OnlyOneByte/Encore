// Track-title normalization (B-7-C1) — turn a YouTube title + uploader into a canonical
// artist/title guess, with provenance.
//
// WHY THIS EXISTS. `Media.artist` is populated from the YouTube UPLOADER, which for the lyric-video
// channels people actually queue is not the artist at all. The live library reads:
//
//   uploader "Evolve"              title "John Mayer - New Light (Lyrics)"
//   uploader "7clouds"             title "Britney Spears - Baby One More Time (Lyrics)"
//   uploader "Musictainment TV"    title "Ain't No Mountain High Enough - Marvin Gaye x Tammi Terrell (Lyrics)"
//   uploader "Mohamad Hafiz"       title "Fun. ft Janelle Monae - We Are Young Official Lyrics"
//   uploader "Daft Punk"           title "Daft Punk - One More Time (Official Video)"
//
// Two features depend on fixing this, which is why it is one function and not two:
//   1. Browse-by-artist (B-7) — grouping by "7clouds" is useless.
//   2. Lyrics lookup (B-3) — LRCLIB is asked for artist+track, so 4 of those 5 rows miss on
//      metadata alone even with LRCLIB perfectly reachable.
//
// PURE: no network, no I/O, no clock. The five rows above are the first five test cases.
//
// This is a HEURISTIC and it says so in its output. Every result carries `by` (which rule fired) and
// `confidence`, matching the provenance convention in docs/media-storage-spec.md §4 — so a caller can
// treat a confident parse and a guess differently instead of storing both as fact.

/** Which rule produced the parse. Recorded as provenance on the canonical fields. */
export type TrackParseRule =
	| 'uploader-confirmed' // the uploader matched one side of the split — strongest signal
	| 'collab-marker-flip' // "A - B x C": the collaboration marker is on the RIGHT, so B x C is the artist
	| 'title-split' // plain "Artist - Title", the dominant convention
	| 'uploader-fallback' // no separator; the uploader is plausibly the artist
	| 'unparsed'; // no separator and the uploader looks like an aggregator channel

export interface ParsedTrack {
	/** Primary artist for lookup ("Marvin Gaye"), or null when we genuinely cannot tell. */
	artist: string | null;
	/** Every credited artist as written ("Marvin Gaye x Tammi Terrell"). Null iff `artist` is null. */
	artistFull: string | null;
	/** Cleaned song title. Never empty — falls back to the cleaned raw title. */
	title: string;
	by: TrackParseRule;
	confidence: 'high' | 'medium' | 'low';
}

// ── noise vocabulary ────────────────────────────────────────────────────────────────
//
// Parenthetical/bracketed junk that describes the UPLOAD, not the recording. Stripped.
// Deliberately does NOT include (Live), (Acoustic), (Remix), (Remastered) or similar: those identify
// a DIFFERENT recording, so dropping them would silently merge two distinct songs.
const NOISE_TERMS = [
	'lyrics',
	'lyric',
	'lyric video',
	'lyrics video',
	'with lyrics',
	'official lyrics',
	'official lyric video',
	'official video',
	'official music video',
	'official audio',
	'official visualizer',
	'official',
	'music video',
	'audio',
	'visualizer',
	'video',
	'hd',
	'hq',
	'4k',
	'8k',
	'1080p',
	'720p',
	'full song',
	'full audio',
	'color coded',
	'color coded lyrics',
	'sub español',
	'legendado'
];

/** Uploader names that are aggregator / lyric channels rather than artists. */
const AGGREGATOR_MARKERS = ['lyric', 'lyrics', 'music tv', 'musictainment', 'vibes', 'clouds', 'nation', 'topic', 'records tv'];

/** Collaboration markers. Their presence on one side of the split means THAT side names artists. */
const COLLAB_RE = /(?:\bft\b\.?|\bfeat\b\.?|\bfeaturing\b|\bwith\b|\bx\b|&|,|\bvs\b\.?)/i;

/** Separators between artist and title, longest first so " -- " beats " - ". */
const SEPARATORS = [' — ', ' – ', ' -- ', ' - ', ' | ', ' _ ', '–', '—'];

// ── helpers ─────────────────────────────────────────────────────────────────────────

/** Strip emoji, pictographs and stray symbol runs. Corp-box titles are full of them ("🎵", "🇺🇸"). */
function stripEmoji(s: string): string {
	// Symbol/pictograph + regional-indicator + variation-selector ranges. Keeps letters, digits,
	// punctuation and CJK — a Japanese title must survive this.
	return s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}]/gu, '');
}

function collapseWs(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** Is this bracketed chunk pure upload-noise (and therefore droppable)? */
function isNoise(inner: string): boolean {
	const t = collapseWs(stripEmoji(inner)).toLowerCase().replace(/[.!]+$/, '');
	if (!t) return true;
	if (NOISE_TERMS.includes(t)) return true;
	// "Official Music Video HD", "Lyrics / Letra" — every word is a noise word
	const words = t.split(/[\s/|]+/).filter(Boolean);
	return words.length > 0 && words.every((w) => NOISE_TERMS.includes(w));
}

/**
 * Remove upload-noise from a title: bracketed noise groups, then trailing bare noise
 * ("... We Are Young Official Lyrics"), then leftover punctuation.
 */
export function cleanTitleNoise(raw: string): string {
	let s = stripEmoji(raw);

	// drop (…) and […] and {…} groups whose contents are pure noise
	s = s.replace(/[([{]([^)\]}]*)[)\]}]/g, (m, inner: string) => (isNoise(inner) ? ' ' : m));

	// trailing bare noise, possibly several ("… Official Lyrics", "… Lyrics HD")
	let changed = true;
	while (changed) {
		changed = false;
		for (const term of NOISE_TERMS) {
			const re = new RegExp(`[\\s\\-|/·]+${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
			if (re.test(s)) {
				s = s.replace(re, '');
				changed = true;
			}
		}
	}

	// a trailing "| Channel Name" style tag adds nothing once noise is gone
	s = s.replace(/\s*\|\s*[^|]{0,40}$/, '');

	return collapseWs(s).replace(/^[\s\-–—|:·]+|[\s\-–—|:·,]+$/g, '');
}

/** The primary artist out of a credit string: "Fun. ft Janelle Monae" → "Fun.". */
export function primaryArtist(credit: string): string {
	const m = COLLAB_RE.exec(credit);
	const head = m && m.index > 0 ? credit.slice(0, m.index) : credit;
	return collapseWs(head).replace(/[\s,&]+$/, '') || collapseWs(credit);
}

/** Normalize for comparison: case-fold, drop emoji/punctuation, collapse space. */
function comparable(s: string): string {
	return collapseWs(stripEmoji(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '));
}

function looksLikeAggregator(uploader: string): boolean {
	const u = comparable(uploader);
	return AGGREGATOR_MARKERS.some((m) => u.includes(m));
}

/** Split on the first separator that yields two non-empty sides. */
function splitSides(s: string): [string, string] | null {
	for (const sep of SEPARATORS) {
		const i = s.indexOf(sep);
		if (i <= 0) continue;
		const left = collapseWs(s.slice(0, i));
		const right = collapseWs(s.slice(i + sep.length));
		if (left && right) return [left, right];
	}
	return null;
}

// ── the parser ──────────────────────────────────────────────────────────────────────

/**
 * Best-effort canonical artist/title from a YouTube title + uploader.
 *
 * Rule order (first match wins):
 *  1. **uploader-confirmed** — the uploader matches one side; that side is the artist. `high`.
 *  2. **collab-marker-flip** — a collaboration marker ("x", "ft", "&") sits on the RIGHT side only,
 *     so the sides are reversed ("Song - Artist x Artist"). This is a real pattern in the live
 *     library and the reason a naive left-is-artist split gets that row backwards. `medium`.
 *  3. **title-split** — plain "Artist - Title". `medium`.
 *  4. **uploader-fallback** — no separator, uploader is not an aggregator → assume it is the artist.
 *     `low`, because it is a guess.
 *  5. **unparsed** — no separator and an aggregator uploader → artist null rather than a known-wrong
 *     value. A null artist is honest; "7clouds" as an artist is the bug this function exists to fix.
 *
 * Callers should gate BROWSE grouping on `confidence !== 'low'` — a low-confidence artist is fine to
 * try against a lyrics API (a miss costs nothing) but not fine to render as a library heading.
 */
export function parseTrackTitle(rawTitle: string, uploader?: string | null): ParsedTrack {
	const cleaned = cleanTitleNoise(rawTitle ?? '');
	const up = collapseWs(uploader ?? '');
	const fallbackTitle = cleaned || collapseWs(stripEmoji(rawTitle ?? '')) || 'Unknown';

	const sides = splitSides(cleaned);

	if (sides) {
		const [left, right] = sides;

		// 1. uploader confirms a side
		if (up) {
			const u = comparable(up);
			const l = comparable(left);
			const r = comparable(right);
			// containment (not equality): "Daft Punk" vs uploader "DaftPunkVEVO" / "Daft Punk Official"
			if (u && l && (u.includes(l) || l.includes(u))) {
				return { artist: primaryArtist(left), artistFull: left, title: right, by: 'uploader-confirmed', confidence: 'high' };
			}
			if (u && r && (u.includes(r) || r.includes(u))) {
				return { artist: primaryArtist(right), artistFull: right, title: left, by: 'uploader-confirmed', confidence: 'high' };
			}
		}

		// 2. collaboration marker on the right ONLY → the sides are reversed
		if (COLLAB_RE.test(right) && !COLLAB_RE.test(left)) {
			return { artist: primaryArtist(right), artistFull: right, title: left, by: 'collab-marker-flip', confidence: 'medium' };
		}

		// 3. the dominant convention
		return { artist: primaryArtist(left), artistFull: left, title: right, by: 'title-split', confidence: 'medium' };
	}

	// 4/5. no separator to work with
	if (up && !looksLikeAggregator(up)) {
		return { artist: primaryArtist(up), artistFull: up, title: fallbackTitle, by: 'uploader-fallback', confidence: 'low' };
	}
	return { artist: null, artistFull: null, title: fallbackTitle, by: 'unparsed', confidence: 'low' };
}
