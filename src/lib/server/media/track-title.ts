// `Media.artist` is the YouTube UPLOADER, which on a lyric-video channel is not the artist — breaking
// browse grouping and the LRCLIB lookup. PURE, and HEURISTIC: every result carries `by`/`confidence`, so a
// caller can treat a guess differently from a confirmed parse.

/** Recorded as provenance on the canonical fields. */
export type TrackParseRule =
	| 'uploader-confirmed' // the uploader matched one side of the split — strongest signal
	| 'collab-marker-flip' // "A - B x C": the collaboration marker is on the RIGHT, so B x C is the artist
	| 'title-split' // plain "Artist - Title", the dominant convention
	| 'uploader-fallback' // no separator; the uploader is plausibly the artist
	| 'unparsed'; // no separator and the uploader looks like an aggregator channel

export interface ParsedTrack {
	/** The PRIMARY, for lookup ("Marvin Gaye"). Null when we genuinely cannot tell. */
	artist: string | null;
	/** Every credited artist as written ("Marvin Gaye x Tammi Terrell"). Null iff `artist` is null. */
	artistFull: string | null;
	/** Never empty — falls back to the cleaned raw title. */
	title: string;
	by: TrackParseRule;
	confidence: 'high' | 'medium' | 'low';
}

// Junk describing the UPLOAD, not the recording. Excludes (Live)/(Acoustic)/(Remix)/(Remastered)
// deliberately: those name a different recording, and dropping them would merge two songs.
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

/** Aggregator and lyric channels, which are not artists. */
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

/** Their presence on one side of the split means THAT side names artists. */
const COLLAB_RE = /(?:\bft\b\.?|\bfeat\b\.?|\bfeaturing\b|\bwith\b|\bx\b|&|,|\bvs\b\.?)/i;

/** Separators between artist and title, longest first so " -- " beats " - ". */
const SEPARATORS = [' — ', ' – ', ' -- ', ' - ', ' | ', ' _ ', '–', '—'];

/** Corp-box titles are full of emoji and stray symbol runs. */
function stripEmoji(s: string): string {
	// Keeps letters, digits, punctuation and CJK. Stripping either half of a regional-indicator pair still removes the composed flag emoji, as intended.
	// eslint-disable-next-line no-misleading-character-class
	return s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}]/gu, '');
}

function collapseWs(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** Is this bracketed chunk pure upload-noise, and so droppable? */
function isNoise(inner: string): boolean {
	const t = collapseWs(stripEmoji(inner))
		.toLowerCase()
		.replace(/[.!]+$/, '');
	if (!t) return true;
	if (NOISE_TERMS.includes(t)) return true;
	const words = t.split(/[\s/|]+/).filter(Boolean);
	return words.length > 0 && words.every((w) => NOISE_TERMS.includes(w));
}

/** Bracketed noise groups, then trailing bare noise, then leftover punctuation. */
export function cleanTitleNoise(raw: string): string {
	let s = stripEmoji(raw);

	s = s.replace(/[([{]([^)\]}]*)[)\]}]/g, (m, inner: string) => (isNoise(inner) ? ' ' : m));

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

	// A trailing "| Channel Name" tag adds nothing once the noise is gone.
	s = s.replace(/\s*\|\s*[^|]{0,40}$/, '');

	return collapseWs(s).replace(/^[\s\-–—|:·]+|[\s\-–—|:·,]+$/g, '');
}

/** "Fun. ft Janelle Monae" -> "Fun.". */
export function primaryArtist(credit: string): string {
	const m = COLLAB_RE.exec(credit);
	const head = m && m.index > 0 ? credit.slice(0, m.index) : credit;
	return collapseWs(head).replace(/[\s,&]+$/, '') || collapseWs(credit);
}

/** Only UNAMBIGUOUS markers: "with" is deliberately absent, since "(with subtitles)" would invent an artist. */
const FEATURED_GROUP_RE = /[([{]\s*(?:ft|feat|featuring)\b\.?\s*([^)\]}]+)[)\]}]/i;

/**
 * "(ft. X)" is billing, not part of the name, and MusicBrainz keys the recording without it. MUST run
 * BEFORE the artist/title split, or a bracketed credit is mistaken for a `COLLAB_RE` side marker and the
 * sides flip. Returns the input unchanged when the credit is all there is.
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

/** In MusicBrainz's own phrasing. */
function withFeatured(artistFull: string, featured: string | null): string {
	return featured ? `${artistFull} feat. ${featured}` : artistFull;
}

/** Case-fold, drop emoji and punctuation, collapse space. */
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

/**
 * First match wins; the rule order is documented per-case on TrackParseRule. Callers MUST gate BROWSE
 * grouping on `confidence !== 'low'`: a low-confidence artist is fine to try against a lyrics API, where a
 * miss costs nothing, but not to render as a library heading.
 */
export function parseTrackTitle(rawTitle: string, uploader?: string | null): ParsedTrack {
	const cleaned = cleanTitleNoise(rawTitle ?? '');
	const up = collapseWs(uploader ?? '');
	// Lift a bracketed guest credit BEFORE looking for a separator — see splitFeaturedCredit for why.
	const lifted = splitFeaturedCredit(cleaned);
	const featured = lifted.featured;
	const body = lifted.title;
	const fallbackTitle = body || collapseWs(stripEmoji(rawTitle ?? '')) || 'Unknown';

	const sides = splitSides(body);

	// Each rule names one side the artist. The lifted guest joins that side's BILLING and never `artist`,
	// which stays the PRIMARY a metadata lookup keys on.
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
			// One direction ONLY — the uploader CONTAINS the side ("Adele" in "AdeleVEVO"). The reverse test
			// lets a channel name anywhere inside a longer side promote the WHOLE side at top confidence.
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

	if (up && !looksLikeAggregator(up)) {
		return resolve(up, fallbackTitle, 'uploader-fallback', 'low');
	}
	// No separator and no usable uploader: DROP the guest credit rather than promote it as the artist.
	return { artist: null, artistFull: null, title: fallbackTitle, by: 'unparsed', confidence: 'low' };
}
