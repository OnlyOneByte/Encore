// The metadata normalizer. The FIRST FIVE tests are the five rows that were actually in the
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
		const p = parseTrackTitle(
			"Ain't No Mountain High Enough - Marvin Gaye x Tammi Terrell (Lyrics) 🎵",
			'Musictainment TV 🇺🇸'
		);
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

// #672: the uploader-confirmed rule tested containment in EITHER direction (`u.includes(side) ||
// side.includes(u)`). The `side.includes(u)` half was the garbage generator: a channel name appearing
// ANYWHERE inside a longer side promoted the WHOLE side to artist at `high` confidence, taking the
// correct artist (on the other side) into the title. Measured across the real 2273-sidecar library, 24
// titles parsed reversed this way.
//
// The three RIGHT-side cases below red on base (artist = the whole qualifier-laden side) and green
// once the loose direction is dropped from both branches — the correct artist then falls through to
// the ordinary title-split. The owner's own costing is that this closes 5 of the 6 KNOWN garbage
// cases; the one it does NOT close is `Tong Hua ( 童话 ) Male Karaoke Mandarin - No Vocal`, where the
// artist "No Vocal" is not a containment artifact but a genuine trailing qualifier with no separator
// signal — that shape is out of scope for this rule (it would need the rejected suffix heuristic).
// The LEFT-side and EXACT cases below pin the OTHER two behaviours the fix must preserve.
describe('#672 — a channel name inside a longer side must not promote the whole side to artist', () => {
	it('"Sophia George - Girlie Girlie (1986) • TopPop" by uploader "TopPop"', () => {
		// r.includes(u): "girlie girlie 1986 toppop" contains "toppop", so the RIGHT side was promoted
		// whole to artist at high confidence. The artist is on the LEFT.
		const p = parseTrackTitle('Sophia George - Girlie Girlie (1986) • TopPop', 'TopPop');
		expect(p.artist).toBe('Sophia George');
		expect(p.title).toBe('Girlie Girlie (1986) • TopPop');
		expect(p.by).toBe('title-split');
	});

	it('"Glimpse Of Us by Joji - Jamal Corrie Cover" by uploader "Jamal Corrie"', () => {
		// r.includes(u): "jamal corrie cover" contains "jamal corrie", so "Jamal Corrie Cover" became the
		// artist. The real song is on the left.
		const p = parseTrackTitle('Glimpse Of Us by Joji - Jamal Corrie Cover', 'Jamal Corrie');
		expect(p.artist).toBe('Glimpse Of Us by Joji');
		expect(p.title).toBe('Jamal Corrie Cover');
		expect(p.by).toBe('title-split');
	});

	it('"Abi Carter Stuns - American Idol 2024" by uploader "American Idol"', () => {
		// r.includes(u): "american idol 2024" contains "american idol", so the trailing show tag was
		// promoted to artist.
		const p = parseTrackTitle('Abi Carter Stuns - American Idol 2024', 'American Idol');
		expect(p.artist).toBe('Abi Carter Stuns');
		expect(p.title).toBe('American Idol 2024');
		expect(p.by).toBe('title-split');
	});

	it('the LEFT-side arm loses its bogus HIGH confidence (the value was already this, the LABEL was not)', () => {
		// l.includes(u): a channel name inside the LEFT side matched too. For THIS shape the artist VALUE
		// is the same either way — "American Idol 2024" is the whole left side, and title-split also
		// names the left side artist — so the fix does NOT change the parsed artist here. What it removes
		// is the `uploader-confirmed`/`high` label the base stamped, demoting it to `title-split`/
		// `medium`. That matters because the medium value is still gated OUT of browse (browseArtist),
		// whereas high would have been rendered as a heading. Uploader "Idol" ⊂ left "American Idol 2024".
		const base = parseTrackTitle('American Idol 2024 - Abi Carter Stuns', 'Idol');
		expect(base.artist).toBe('American Idol 2024'); // unchanged value for this shape
		expect(base.by).toBe('title-split'); // RED on base: base stamps 'uploader-confirmed'
		expect(base.confidence).toBe('medium'); // RED on base: base stamps 'high'
	});

	it('an EXACT uploader match still confirms — the kept direction is untouched', () => {
		// u.includes(side) survives: exact matches (Daft Punk, Queen) and the VEVO case (AdeleVEVO ⊃
		// Adele) are still high-confidence uploader-confirmed. This is what makes the fix test-safe.
		expect(parseTrackTitle('Bohemian Rhapsody - Queen', 'Queen').by).toBe('uploader-confirmed');
		expect(parseTrackTitle('Adele - Hello', 'AdeleVEVO').by).toBe('uploader-confirmed');
		expect(parseTrackTitle('Daft Punk - One More Time', 'Daft Punk').by).toBe('uploader-confirmed');
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

describe('a guest credit inside the TITLE belongs to the billing', () => {
	// The live regression: this title cleans to one with no separator left in it (the trailing
	// "| Worlds 2017 - League of Legends" tag is stripped), so the parser falls back to the uploader —
	// which here is genuinely the credited artist. MusicBrainz calls the recording "Legends Never Die"
	// and returns ZERO results for the name with "(ft. …)" still attached, so leaving the credit in the
	// title is what made the annotation unreachable and left the raw upload string on the TV.
	it('lifts "(ft. …)" out of the song name and into the credit', () => {
		const p = parseTrackTitle(
			'Legends Never Die (ft. Against The Current) [OFFICIAL AUDIO] | Worlds 2017 - League of Legends',
			'League of Legends'
		);
		expect(p.title).toBe('Legends Never Die');
		expect(p.artist).toBe('League of Legends');
		expect(p.artistFull).toBe('League of Legends feat. Against The Current');
		expect(p.by).toBe('uploader-fallback');
	});

	it('lifts it from a plain artist - title split too, leaving the primary alone', () => {
		// Also a REVERSAL fix. Before the lift ran first, COLLAB_RE saw "feat" on the right side only and
		// fired collab-marker-flip, so this stored artist "Telephone (" and title "Lady Gaga" — at
		// `medium`, which is confident enough to become a browse heading.
		const p = parseTrackTitle('Lady Gaga - Telephone (feat. Beyoncé)', 'LadyGagaVEVO');
		expect(p.title).toBe('Telephone');
		expect(p.artist).toBe('Lady Gaga');
		expect(p.artistFull).toBe('Lady Gaga feat. Beyoncé');
		expect(p.by).toBe('title-split');
	});

	it('lifts it from the ARTIST side too', () => {
		const p = parseTrackTitle('Lady Gaga (feat. Beyoncé) - Telephone', 'LadyGagaVEVO');
		expect(p.title).toBe('Telephone');
		expect(p.artist).toBe('Lady Gaga');
		expect(p.artistFull).toBe('Lady Gaga feat. Beyoncé');
	});

	it('still flips a BARE collaboration marker — that rule is untouched', () => {
		// "Ain't No Mountain High Enough - Marvin Gaye x Tammi Terrell": the marker is unbracketed, so it
		// really is the signal that the sides are reversed.
		const p = parseTrackTitle("Ain't No Mountain High Enough - Marvin Gaye x Tammi Terrell", 'Musictainment TV');
		expect(p.by).toBe('collab-marker-flip');
		expect(p.artist).toBe('Marvin Gaye');
		expect(p.title).toBe("Ain't No Mountain High Enough");
	});

	it('accepts [feat. …] and (featuring …) as the same thing', () => {
		expect(parseTrackTitle('A - T [feat. B]', 'A').artistFull).toBe('A feat. B');
		expect(parseTrackTitle('A - T (featuring B)', 'A').artistFull).toBe('A feat. B');
	});

	it('does NOT lift "(with …)" — "(with subtitles)" is not an artist', () => {
		const p = parseTrackTitle('A - T (with subtitles)', 'A');
		expect(p.artistFull).toBe('A');
		expect(p.title).toBe('T (with subtitles)');
	});

	it('leaves a title that is ONLY a credit alone rather than emptying it', () => {
		// An empty song name is worse than a noisy one: it would render as a blank lower third.
		const p = parseTrackTitle('(feat. Someone)', 'Uploader');
		expect(p.title).toBe('(feat. Someone)');
		expect(p.artistFull).toBe('Uploader');
	});

	it('drops the guest when there is no artist to bill it to, rather than promoting it', () => {
		// `unparsed` means we could not name the artist. A featured guest is still not the artist, so
		// publishing it would be a known-wrong value — the bug this whole module exists to avoid.
		const p = parseTrackTitle('Some Song (feat. Guest)', '7clouds');
		expect(p.by).toBe('unparsed');
		expect(p.artist).toBeNull();
		expect(p.artistFull).toBeNull();
		expect(p.title).toBe('Some Song');
	});

	it('does not disturb a recording qualifier that identifies a DIFFERENT take', () => {
		// (Live), (Remix), (Instrumental) name another recording; dropping them would merge two songs.
		expect(parseTrackTitle('A - T (Live)', 'A').title).toBe('T (Live)');
		expect(parseTrackTitle('A - T (Instrumental)', 'A').title).toBe('T (Instrumental)');
	});
});
