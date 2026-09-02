// B-7-C1 — the metadata normalizer. The FIRST FIVE tests are the five rows that were actually in the
// live library on 2026-09-02, because they are what made this necessary: `media.artist` held the
// YouTube uploader, so four of the five would have been grouped under a lyric-video channel and would
// have missed an LRCLIB lookup entirely.
import { describe, expect, it } from 'bun:test';
import { parseTrackTitle, cleanTitleNoise, primaryArtist } from './track-title';

describe('the live library (the reason this exists)', () => {
	it('"John Mayer - New Light (Lyrics)" by uploader "Evolve"', () => {
		const p = parseTrackTitle('John Mayer - New Light (Lyrics)', 'Evolve');
		expect(p.artist).toBe('John Mayer');
		expect(p.title).toBe('New Light');
		expect(p.by).toBe('title-split');
	});

	it('"Britney Spears - Baby One More Time (Lyrics)" by uploader "7clouds"', () => {
		const p = parseTrackTitle('Britney Spears - Baby One More Time (Lyrics)', '7clouds');
		expect(p.artist).toBe('Britney Spears');
		expect(p.title).toBe('Baby One More Time');
	});

	it('REVERSED: "Ain\'t No Mountain High Enough - Marvin Gaye x Tammi Terrell (Lyrics) 🎵"', () => {
		// The hard one, and it is real. A naive left-is-artist split makes the SONG the artist. The
		// "x" collaboration marker sits on the right, which is what reveals the sides are swapped.
		const p = parseTrackTitle("Ain't No Mountain High Enough - Marvin Gaye x Tammi Terrell (Lyrics) 🎵", 'Musictainment TV 🇺🇸');
		expect(p.title).toBe("Ain't No Mountain High Enough");
		expect(p.artist).toBe('Marvin Gaye');
		expect(p.artistFull).toBe('Marvin Gaye x Tammi Terrell');
		expect(p.by).toBe('collab-marker-flip');
	});

	it('"Fun. ft Janelle Monae - We Are Young Official Lyrics" (bare trailing noise, ft on the LEFT)', () => {
		const p = parseTrackTitle('Fun. ft Janelle Monae - We Are Young Official Lyrics', 'Mohamad Hafiz');
		expect(p.title).toBe('We Are Young'); // "Official Lyrics" had no brackets to key off
		expect(p.artist).toBe('Fun.'); // primary artist for the lookup
		expect(p.artistFull).toBe('Fun. ft Janelle Monae'); // full credit preserved
		expect(p.by).toBe('title-split'); // marker is on the left, so no flip
	});

	it('"Daft Punk - One More Time (Official Video)" by uploader "Daft Punk" → high confidence', () => {
		const p = parseTrackTitle('Daft Punk - One More Time (Official Video)', 'Daft Punk');
		expect(p.artist).toBe('Daft Punk');
		expect(p.title).toBe('One More Time');
		expect(p.by).toBe('uploader-confirmed');
		expect(p.confidence).toBe('high'); // the uploader agreeing is the strongest signal we get
	});
});

describe('confidence and provenance', () => {
	it('an uploader that confirms a side beats the positional heuristic', () => {
		// Uploader names the RIGHT side, so the sides must be reversed even with no collab marker.
		const p = parseTrackTitle('Bohemian Rhapsody - Queen', 'Queen');
		expect(p.artist).toBe('Queen');
		expect(p.title).toBe('Bohemian Rhapsody');
		expect(p.confidence).toBe('high');
	});

	it('a VEVO-style uploader still confirms by containment', () => {
		const p = parseTrackTitle('Adele - Hello', 'AdeleVEVO');
		expect(p.by).toBe('uploader-confirmed');
		expect(p.artist).toBe('Adele');
	});

	it('no separator + aggregator uploader → null artist, NOT the channel name', () => {
		// This is the whole point: a null artist is honest, "7clouds" as an artist is the bug.
		const p = parseTrackTitle('Baby One More Time', '7clouds');
		expect(p.artist).toBeNull();
		expect(p.by).toBe('unparsed');
		expect(p.confidence).toBe('low');
		expect(p.title).toBe('Baby One More Time'); // title still usable
	});

	it('no separator + plausible artist uploader → uploader as artist at LOW confidence', () => {
		const p = parseTrackTitle('Bohemian Rhapsody', 'Queen');
		expect(p.artist).toBe('Queen');
		expect(p.by).toBe('uploader-fallback');
		expect(p.confidence).toBe('low'); // fine to try against a lyrics API, not fine as a browse heading
	});

	it('never returns an empty title', () => {
		expect(parseTrackTitle('(Official Video)', '').title).toBeTruthy();
		expect(parseTrackTitle('', '').title).toBe('Unknown');
		expect(parseTrackTitle('🎵🎵', '').title).toBeTruthy();
	});
});

describe('cleanTitleNoise', () => {
	it('strips bracketed upload noise in any bracket style', () => {
		expect(cleanTitleNoise('Song (Official Music Video)')).toBe('Song');
		expect(cleanTitleNoise('Song [HD]')).toBe('Song');
		expect(cleanTitleNoise('Song (Lyrics) [4K]')).toBe('Song');
		expect(cleanTitleNoise('Song (Official Video HD)')).toBe('Song'); // every word is noise
	});

	it('KEEPS bracketed terms that identify a different recording', () => {
		// Dropping these would silently merge two distinct songs into one library entry.
		expect(cleanTitleNoise('Song (Live)')).toBe('Song (Live)');
		expect(cleanTitleNoise('Song (Acoustic)')).toBe('Song (Acoustic)');
		expect(cleanTitleNoise('Song (Remastered)')).toBe('Song (Remastered)');
		expect(cleanTitleNoise('Song (Radio Remix)')).toBe('Song (Radio Remix)');
	});

	it('strips trailing bare noise, including several in a row', () => {
		expect(cleanTitleNoise('We Are Young Official Lyrics')).toBe('We Are Young');
		expect(cleanTitleNoise('Song Lyrics HD')).toBe('Song');
	});

	it('strips emoji but preserves non-Latin scripts', () => {
		expect(cleanTitleNoise('Song 🎵🔥')).toBe('Song');
		expect(cleanTitleNoise('夜に駆ける (Lyrics)')).toBe('夜に駆ける');
	});

	it('leaves an already-clean title alone', () => {
		expect(cleanTitleNoise('New Light')).toBe('New Light');
	});
});

describe('primaryArtist', () => {
	it('takes the head of a collaboration credit', () => {
		expect(primaryArtist('Fun. ft Janelle Monae')).toBe('Fun.');
		expect(primaryArtist('Marvin Gaye x Tammi Terrell')).toBe('Marvin Gaye');
		expect(primaryArtist('Calvin Harris & Dua Lipa')).toBe('Calvin Harris');
		expect(primaryArtist('Jay-Z, Kanye West')).toBe('Jay-Z');
		expect(primaryArtist('Artist feat. Other')).toBe('Artist');
	});

	it('does not mistake a marker INSIDE a word for a collaboration', () => {
		// "Remix" contains an x; "Xanadu" starts with one; "Foxes" has one mid-word.
		expect(primaryArtist('Foxes')).toBe('Foxes');
		expect(primaryArtist('Xanadu')).toBe('Xanadu');
	});

	it('returns a lone artist unchanged', () => {
		expect(primaryArtist('Daft Punk')).toBe('Daft Punk');
	});
});

describe('separators', () => {
	it('handles en-dash, em-dash and double-hyphen', () => {
		expect(parseTrackTitle('Artist – Title', '').title).toBe('Title');
		expect(parseTrackTitle('Artist — Title', '').title).toBe('Title');
		expect(parseTrackTitle('Artist -- Title', '').title).toBe('Title');
	});

	it('does not split on a hyphen inside a word', () => {
		const p = parseTrackTitle('Jay-Z - The Story of O.J.', 'Jay-Z');
		expect(p.artist).toBe('Jay-Z');
		expect(p.title).toBe('The Story of O.J.');
	});
});
