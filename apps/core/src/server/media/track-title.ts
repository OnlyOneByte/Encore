// Track-title normalization — turn a YouTube title + uploader into a canonical
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
//   1. Browse-by-artist — grouping by "7clouds" is useless.
//   2. Lyrics lookup — LRCLIB is asked for artist+track, so 4 of those 5 rows miss on
//      metadata alone even with LRCLIB perfectly reachable.
//
// PURE: no network, no I/O, no clock. The five rows above are the first five test cases.
//
// This is a HEURISTIC and it says so in its output. Every result carries `by` (which rule fired) and
// `confidence`, matching the provenance convention in docs/ARCHITECTURE.md — so a caller can
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
const AGGREGATOR_MARKERS = [
	'lyric',
	'lyrics',
	'music tv',
	'musictainment',
	'vibes',
	'clouds',
	'nation',
	'topic',
	'records tv'
];

/** Collaboration markers. Their presence on one side of the split means THAT side names artists. */
const COLLAB_RE = /(?:\bft\b\.?|\bfeat\b\.?|\bfeaturing\b|\bwith\b|\bx\b|&|,|\bvs\b\.?)/i;

/** Separators between artist and title, longest first so " -- " beats " - ". */
const SEPARATORS = [' — ', ' – ', ' -- ', ' - ', ' | ', ' _ ', '–', '—'];

// ── helpers ─────────────────────────────────────────────────────────────────────────

/** Strip emoji, pictographs and stray symbol runs. Corp-box titles are full of them ("🎵", "🇺🇸"). */
function stripEmoji(s: string): string {
	// Symbol/pictograph + regional-indicator + variation-selector ranges. Keeps letters, digits,
	// punctuation and CJK — a Japanese title must survive this.
	// Regional-indicator range (U+1F1E6-U+1F1FF) composes into flag emoji; stripping either half
	// removes the flag, which is the intent — so the combined-character warning does not apply.
	// eslint-disable-next-line no-misleading-character-class
	return s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}]/gu, '');
}

function collapseWs(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** Is this bracketed chunk pure upload-noise (and therefore droppable)? */
function isNoise(inner: string): boolean {
	const t = collapseWs(stripEmoji(inner))
		.toLowerCase()
		.replace(/[.!]+$/, '');
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

/**
 * A bracketed guest credit inside a TITLE — "(ft. Against The Current)", "[feat. Beyoncé]".
 *
 * Only the unambiguous markers. "with" is deliberately absent: "(with lyrics)" is upload noise and
 * "(with subtitles)" is neither a credit nor in NOISE_TERMS, so accepting it would invent an artist.
 */
const FEATURED_GROUP_RE = /[([{]\s*(?:ft|feat|featuring)\b\.?\s*([^)\]}]+)[)\]}]/i;

/**
 * Lift a guest credit OUT of a song title.
 *
 * WHY. "(ft. Against The Current)" is billing, not part of the song's name — MusicBrainz stores it in
 * `artist-credit` and calls the recording "Legends Never Die". Leaving it in the title key made the
 * MusicBrainz query return ZERO results for a song the service knows perfectly well, so the annotation
 * silently declined and the TV kept rendering the raw upload title. It is also simply wrong on screen:
 * the song is called "Legends Never Die".
 *
 * Runs BEFORE the artist/title split, because a bracketed credit is not a hint about which side names
 * the artists — and putting it in front of `COLLAB_RE` made it one, flipping "Lady Gaga - Telephone
 * (feat. Beyoncé)" into artist "Telephone (" / title "Lady Gaga". Bare markers ("A - B x C") are left
 * alone, so the flip rule keeps working for the case it was written for.
 *
 * Returns the input unchanged when the credit is all there is ("(feat. X)" alone) — an empty song name
 * would render as a blank lower third, which is worse than a noisy one.
 */
export function splitFeaturedCredit(title: string): { title: string; featured: string | null } {
	const m = FEATURED_GROUP_RE.exec(title);
	if (!m) return { title, featured: null };
	const featured = collapseWs(m[1]).replace(/[\s,&]+$/, '');
	const stripped = collapseWs(`${title.slice(0, m.index)} ${title.slice(m.index + m[0].length)}`).replace(
		/^[\s\-–—|:·]+|[\s\-–—|:·,]+$/g,
		''
	);
	if (!stripped || !featured) return { title, featured: null };
	return { title: stripped, featured };
}

/** Join a primary billing with a lifted guest credit, in MusicBrainz's own phrasing. */
function withFeatured(artistFull: string, featured: string | null): string {
	return featured ? `${artistFull} feat. ${featured}` : artistFull;
}

/** Normalize for comparison: case-fold, drop emoji/punctuation, collapse space. */
function comparable(s: string): string {
	return collapseWs(
		stripEmoji(s)
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, ' ')
	);
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
 * Rule order (first match wins); each rule is documented on TrackParseRule. Two are non-obvious:
 *  - **collab-marker-flip** — a marker ("x", "ft", "&") on the RIGHT side only means the sides are
 *    reversed ("Song - Artist x Artist"); a real live-library pattern that a naive left-is-artist
 *    split gets backwards.
 *  - **unparsed** — no separator + aggregator uploader → artist null, not a known-wrong value.
 *    "7clouds" as an artist is the bug this function exists to fix.
 *
 * Callers should gate BROWSE grouping on `confidence !== 'low'` — a low-confidence artist is fine to
 * try against a lyrics API (a miss costs nothing) but not to render as a library heading.
 */
export function parseTrackTitle(rawTitle: string, uploader?: string | null): ParsedTrack {
	const cleaned = cleanTitleNoise(rawTitle ?? '');
	const up = collapseWs(uploader ?? '');
	// Lift a bracketed guest credit BEFORE anything looks for a separator. It is billing, not a hint
	// about which side names the artists — and leaving it in front of `COLLAB_RE` was an active bug:
	// "Lady Gaga - Telephone (feat. Beyoncé)" fired collab-marker-flip on the parenthetical and came
	// back with artist "Telephone (" and title "Lady Gaga", stored at `medium` and rendered as a browse
	// heading. Only BRACKETED markers are lifted, so a bare "A - B x C" still flips as it should.
	const lifted = splitFeaturedCredit(cleaned);
	const featured = lifted.featured;
	const body = lifted.title;
	const fallbackTitle = body || collapseWs(stripEmoji(rawTitle ?? '')) || 'Unknown';

	const sides = splitSides(body);

	// Each rule below names one side the artist; the lifted guest is added to that side's billing and
	// never to `artist`, which stays the PRIMARY a metadata lookup keys on.
	const resolve = (
		artistSide: string,
		titleSide: string,
		by: TrackParseRule,
		confidence: ParsedTrack['confidence']
	): ParsedTrack => ({
		artist: primaryArtist(artistSide),
		artistFull: withFeatured(artistSide, featured),
		title: titleSide,
		by,
		confidence
	});

	if (sides) {
		const [left, right] = sides;

		// 1. uploader confirms a side
		if (up) {
			const u = comparable(up);
			const l = comparable(left);
			const r = comparable(right);
			// The uploader must CONTAIN the side, one direction only: "Adele" ⊂ "AdeleVEVO", "Daft Punk"
			// == "Daft Punk". The reverse test — side.includes(u) — was the garbage generator (#672): a
			// channel name sitting ANYWHERE inside a longer side promoted the WHOLE side to artist at the
			// parser's highest confidence, so "Sophia George - Girlie Girlie (1986) • TopPop" by uploader
			// "TopPop" wrote artist "Girlie Girlie (1986) • TopPop" and "Glimpse Of Us by Joji - Jamal
			// Corrie Cover" by "Jamal Corrie" wrote artist "Jamal Corrie Cover". Both branches carried it,
			// so a title-longer-than-uploader match on the LEFT was reversed too; dropping it from both is
			// what closes the defect at its source rather than by suffix vocabulary. No existing case
			// needs the loose form — every pinned uploader-confirmed match is exact or the kept direction.
			if (u && l && u.includes(l)) {
				return resolve(left, right, 'uploader-confirmed', 'high');
			}
			if (u && r && u.includes(r)) {
				return resolve(right, left, 'uploader-confirmed', 'high');
			}
		}

		// 2. collaboration marker on the right ONLY → the sides are reversed
		if (COLLAB_RE.test(right) && !COLLAB_RE.test(left)) {
			return resolve(right, left, 'collab-marker-flip', 'medium');
		}

		// 3. the dominant convention
		return resolve(left, right, 'title-split', 'medium');
	}

	// 4/5. no separator to work with
	if (up && !looksLikeAggregator(up)) {
		return resolve(up, fallbackTitle, 'uploader-fallback', 'low');
	}
	// Nothing to stand behind as an artist, so the guest credit is DROPPED rather than promoted: "(ft.
	// X)" names a guest, and publishing it as the artist would be a known-wrong value.
	return { artist: null, artistFull: null, title: fallbackTitle, by: 'unparsed', confidence: 'low' };
}
