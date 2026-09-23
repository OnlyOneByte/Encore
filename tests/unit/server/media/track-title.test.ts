// The metadata normalizer. The first five tests are real library rows: with `media.artist` holding the
// YouTube uploader, four of the five group under a lyric-video channel and miss an LRCLIB lookup entirely.
import { expect, it } from 'bun:test';
import { parseTrackTitle, cleanTitleNoise, primaryArtist } from '$lib/server/media/track-title';

it('the live library (the reason this exists): "John Mayer - New Light (Lyrics)" by uploader "Evolve"', () => {
	const p = parseTrackTitle('John Mayer - New Light (Lyrics)', 'Evolve');
	expect(p.artist).toBe('John Mayer');
	expect(p.title).toBe('New Light');
	expect(p.by).toBe('title-split');
});

it('the live library (the reason this exists): "Britney Spears - Baby One More Time (Lyrics)" by uploader "7clouds"', () => {
	const p = parseTrackTitle('Britney Spears - Baby One More Time (Lyrics)', '7clouds');
	expect(p.artist).toBe('Britney Spears');
	expect(p.title).toBe('Baby One More Time');
});

it('the live library (the reason this exists) — REVERSED: "Ain\'t No Mountain High Enough - Marvin Gaye x Tammi Terrell (Lyrics) 🎵"', () => {
	// A naive left-is-artist split makes the SONG the artist; the "x" collaboration marker on the right is
	// what reveals the sides are swapped.
	const p = parseTrackTitle(
		"Ain't No Mountain High Enough - Marvin Gaye x Tammi Terrell (Lyrics) 🎵",
		'Musictainment TV 🇺🇸'
	);
	expect(p.title).toBe("Ain't No Mountain High Enough");
	expect(p.artist).toBe('Marvin Gaye');
	expect(p.artistFull).toBe('Marvin Gaye x Tammi Terrell');
	expect(p.by).toBe('collab-marker-flip');
});

it('the live library (the reason this exists): "Fun. ft Janelle Monae - We Are Young Official Lyrics" (bare trailing noise, ft on the LEFT)', () => {
	const p = parseTrackTitle('Fun. ft Janelle Monae - We Are Young Official Lyrics', 'Mohamad Hafiz');
	expect(p.title).toBe('We Are Young'); // "Official Lyrics" had no brackets to key off
	expect(p.artist).toBe('Fun.'); // primary artist for the lookup
	expect(p.artistFull).toBe('Fun. ft Janelle Monae'); // full credit preserved
	expect(p.by).toBe('title-split'); // marker is on the left, so no flip
});

it('the live library (the reason this exists): "Daft Punk - One More Time (Official Video)" by uploader "Daft Punk" → high confidence', () => {
	const p = parseTrackTitle('Daft Punk - One More Time (Official Video)', 'Daft Punk');
	expect(p.artist).toBe('Daft Punk');
	expect(p.title).toBe('One More Time');
	expect(p.by).toBe('uploader-confirmed');
	expect(p.confidence).toBe('high'); // the uploader agreeing is the strongest signal we get
});

it('confidence and provenance: an uploader that confirms a side beats the positional heuristic', () => {
	// The uploader names the RIGHT side, so the sides reverse even with no collab marker.
	const p = parseTrackTitle('Bohemian Rhapsody - Queen', 'Queen');
	expect(p.artist).toBe('Queen');
	expect(p.title).toBe('Bohemian Rhapsody');
	expect(p.confidence).toBe('high');
});

it('confidence and provenance: a VEVO-style uploader still confirms by containment', () => {
	const p = parseTrackTitle('Adele - Hello', 'AdeleVEVO');
	expect(p.by).toBe('uploader-confirmed');
	expect(p.artist).toBe('Adele');
});

it('confidence and provenance: no separator + aggregator uploader → null artist, NOT the channel name', () => {
	// A null artist is honest; a channel name as the artist is the bug.
	const p = parseTrackTitle('Baby One More Time', '7clouds');
	expect(p.artist).toBeNull();
	expect(p.by).toBe('unparsed');
	expect(p.confidence).toBe('low');
	expect(p.title).toBe('Baby One More Time'); // title still usable
});

it('confidence and provenance: no separator + plausible artist uploader → uploader as artist at LOW confidence', () => {
	const p = parseTrackTitle('Bohemian Rhapsody', 'Queen');
	expect(p.artist).toBe('Queen');
	expect(p.by).toBe('uploader-fallback');
	expect(p.confidence).toBe('low'); // fine to try against a lyrics API, not fine as a browse heading
});

it('confidence and provenance: never returns an empty title', () => {
	expect(parseTrackTitle('(Official Video)', '').title).toBeTruthy();
	expect(parseTrackTitle('', '').title).toBe('Unknown');
	expect(parseTrackTitle('🎵🎵', '').title).toBeTruthy();
});

// The uploader-confirmed rule must test containment in ONE direction only (`u.includes(side)`). The `side.includes(u)`
// half is a garbage generator: a channel name appearing ANYWHERE inside a longer side promotes the WHOLE side to artist
// at `high` confidence, taking the correct artist on the other side into the title — 24 titles across a real
// 2273-sidecar library parsed reversed that way. The RIGHT-side cases below are the ones the loose direction breaks; the
// LEFT-side and EXACT cases pin what must survive dropping it. Out of scope: a genuine trailing qualifier with no
// separator signal ("… - No Vocal"), which is not a containment artifact.
it('a channel name inside a longer side must not promote the whole side to artist: "Sophia George - Girlie Girlie (1986) • TopPop" by uploader "TopPop"', () => {
	// r.includes(u): the right side contains the uploader, so it is promoted whole to artist at high
	// confidence. The artist is on the LEFT.
	const p = parseTrackTitle('Sophia George - Girlie Girlie (1986) • TopPop', 'TopPop');
	expect(p.artist).toBe('Sophia George');
	expect(p.title).toBe('Girlie Girlie (1986) • TopPop');
	expect(p.by).toBe('title-split');
});

it('a channel name inside a longer side must not promote the whole side to artist: "Glimpse Of Us by Joji - Jamal Corrie Cover" by uploader "Jamal Corrie"', () => {
	// r.includes(u): the right side contains the uploader, so the qualifier-laden side becomes the artist.
	const p = parseTrackTitle('Glimpse Of Us by Joji - Jamal Corrie Cover', 'Jamal Corrie');
	expect(p.artist).toBe('Glimpse Of Us by Joji');
	expect(p.title).toBe('Jamal Corrie Cover');
	expect(p.by).toBe('title-split');
});

it('a channel name inside a longer side must not promote the whole side to artist: "Abi Carter Stuns - American Idol 2024" by uploader "American Idol"', () => {
	// r.includes(u): the trailing show tag is promoted to artist.
	const p = parseTrackTitle('Abi Carter Stuns - American Idol 2024', 'American Idol');
	expect(p.artist).toBe('Abi Carter Stuns');
	expect(p.title).toBe('American Idol 2024');
	expect(p.by).toBe('title-split');
});

it('a channel name inside a longer side must not promote the whole side to artist: the LEFT-side arm loses its bogus HIGH confidence (the value was already this, the LABEL was not)', () => {
	// l.includes(u): a channel name inside the LEFT side matches too. The artist VALUE is the same either way here, since
	// title-split also names the left side — what changes is the CONFIDENCE, from `uploader-confirmed`/high down to
	// `title-split`/medium, and medium is gated OUT of browse where high would have been rendered as a heading.
	const base = parseTrackTitle('American Idol 2024 - Abi Carter Stuns', 'Idol');
	expect(base.artist).toBe('American Idol 2024'); // unchanged value for this shape
	expect(base.by).toBe('title-split'); // RED on base: base stamps 'uploader-confirmed'
	expect(base.confidence).toBe('medium'); // RED on base: base stamps 'high'
});

it('a channel name inside a longer side must not promote the whole side to artist: an EXACT uploader match still confirms — the kept direction is untouched', () => {
	// u.includes(side) survives: exact matches and the VEVO case (AdeleVEVO ⊃ Adele) stay high-confidence.
	expect(parseTrackTitle('Bohemian Rhapsody - Queen', 'Queen').by).toBe('uploader-confirmed');
	expect(parseTrackTitle('Adele - Hello', 'AdeleVEVO').by).toBe('uploader-confirmed');
	expect(parseTrackTitle('Daft Punk - One More Time', 'Daft Punk').by).toBe('uploader-confirmed');
});

it('cleanTitleNoise: strips bracketed upload noise in any bracket style', () => {
	expect(cleanTitleNoise('Song (Official Music Video)')).toBe('Song');
	expect(cleanTitleNoise('Song [HD]')).toBe('Song');
	expect(cleanTitleNoise('Song (Lyrics) [4K]')).toBe('Song');
	expect(cleanTitleNoise('Song (Official Video HD)')).toBe('Song'); // every word is noise
});

it('cleanTitleNoise: KEEPS bracketed terms that identify a different recording', () => {
	// Dropping these silently merges two distinct songs into one library entry.
	expect(cleanTitleNoise('Song (Live)')).toBe('Song (Live)');
	expect(cleanTitleNoise('Song (Acoustic)')).toBe('Song (Acoustic)');
	expect(cleanTitleNoise('Song (Remastered)')).toBe('Song (Remastered)');
	expect(cleanTitleNoise('Song (Radio Remix)')).toBe('Song (Radio Remix)');
});

it('cleanTitleNoise: strips trailing bare noise, including several in a row', () => {
	expect(cleanTitleNoise('We Are Young Official Lyrics')).toBe('We Are Young');
	expect(cleanTitleNoise('Song Lyrics HD')).toBe('Song');
});

it('cleanTitleNoise: strips emoji but preserves non-Latin scripts', () => {
	expect(cleanTitleNoise('Song 🎵🔥')).toBe('Song');
	expect(cleanTitleNoise('夜に駆ける (Lyrics)')).toBe('夜に駆ける');
});

it('cleanTitleNoise: leaves an already-clean title alone', () => {
	expect(cleanTitleNoise('New Light')).toBe('New Light');
});

it('primaryArtist: takes the head of a collaboration credit', () => {
	expect(primaryArtist('Fun. ft Janelle Monae')).toBe('Fun.');
	expect(primaryArtist('Marvin Gaye x Tammi Terrell')).toBe('Marvin Gaye');
	expect(primaryArtist('Calvin Harris & Dua Lipa')).toBe('Calvin Harris');
	expect(primaryArtist('Jay-Z, Kanye West')).toBe('Jay-Z');
	expect(primaryArtist('Artist feat. Other')).toBe('Artist');
});

it('primaryArtist: does not mistake a marker INSIDE a word for a collaboration', () => {
	expect(primaryArtist('Foxes')).toBe('Foxes');
	expect(primaryArtist('Xanadu')).toBe('Xanadu');
});

it('primaryArtist: returns a lone artist unchanged', () => {
	expect(primaryArtist('Daft Punk')).toBe('Daft Punk');
});

it('separators: handles en-dash, em-dash and double-hyphen', () => {
	expect(parseTrackTitle('Artist – Title', '').title).toBe('Title');
	expect(parseTrackTitle('Artist — Title', '').title).toBe('Title');
	expect(parseTrackTitle('Artist -- Title', '').title).toBe('Title');
});

it('separators: does not split on a hyphen inside a word', () => {
	const p = parseTrackTitle('Jay-Z - The Story of O.J.', 'Jay-Z');
	expect(p.artist).toBe('Jay-Z');
	expect(p.title).toBe('The Story of O.J.');
});

// This title cleans to one with no separator left in it, so the parser falls back to the uploader — which
// here is genuinely the credited artist. MusicBrainz returns ZERO results for the name with "(ft. …)"
// still attached, so leaving the credit in the title makes the annotation unreachable.
it('a guest credit inside the TITLE belongs to the billing: lifts "(ft. …)" out of the song name and into the credit', () => {
	const p = parseTrackTitle(
		'Legends Never Die (ft. Against The Current) [OFFICIAL AUDIO] | Worlds 2017 - League of Legends',
		'League of Legends'
	);
	expect(p.title).toBe('Legends Never Die');
	expect(p.artist).toBe('League of Legends');
	expect(p.artistFull).toBe('League of Legends feat. Against The Current');
	expect(p.by).toBe('uploader-fallback');
});

it('a guest credit inside the TITLE belongs to the billing: lifts it from a plain artist - title split too, leaving the primary alone', () => {
	// Also a REVERSAL: with the credit lift running second, COLLAB_RE sees "feat" on the right side only and fires
	// collab-marker-flip, storing artist "Telephone (" at `medium` — confident enough to become a browse heading.
	const p = parseTrackTitle('Lady Gaga - Telephone (feat. Beyoncé)', 'LadyGagaVEVO');
	expect(p.title).toBe('Telephone');
	expect(p.artist).toBe('Lady Gaga');
	expect(p.artistFull).toBe('Lady Gaga feat. Beyoncé');
	expect(p.by).toBe('title-split');
});

it('a guest credit inside the TITLE belongs to the billing: lifts it from the ARTIST side too', () => {
	const p = parseTrackTitle('Lady Gaga (feat. Beyoncé) - Telephone', 'LadyGagaVEVO');
	expect(p.title).toBe('Telephone');
	expect(p.artist).toBe('Lady Gaga');
	expect(p.artistFull).toBe('Lady Gaga feat. Beyoncé');
});

it('a guest credit inside the TITLE belongs to the billing: still flips a BARE collaboration marker — that rule is untouched', () => {
	// The marker is unbracketed, so it really is the signal that the sides are reversed.
	const p = parseTrackTitle("Ain't No Mountain High Enough - Marvin Gaye x Tammi Terrell", 'Musictainment TV');
	expect(p.by).toBe('collab-marker-flip');
	expect(p.artist).toBe('Marvin Gaye');
	expect(p.title).toBe("Ain't No Mountain High Enough");
});

it('a guest credit inside the TITLE belongs to the billing: accepts [feat. …] and (featuring …) as the same thing', () => {
	expect(parseTrackTitle('A - T [feat. B]', 'A').artistFull).toBe('A feat. B');
	expect(parseTrackTitle('A - T (featuring B)', 'A').artistFull).toBe('A feat. B');
});

it('a guest credit inside the TITLE belongs to the billing: does NOT lift "(with …)" — "(with subtitles)" is not an artist', () => {
	const p = parseTrackTitle('A - T (with subtitles)', 'A');
	expect(p.artistFull).toBe('A');
	expect(p.title).toBe('T (with subtitles)');
});

it('a guest credit inside the TITLE belongs to the billing: leaves a title that is ONLY a credit alone rather than emptying it', () => {
	// An empty song name is worse than a noisy one: it renders as a blank lower third.
	const p = parseTrackTitle('(feat. Someone)', 'Uploader');
	expect(p.title).toBe('(feat. Someone)');
	expect(p.artistFull).toBe('Uploader');
});

it('a guest credit inside the TITLE belongs to the billing: drops the guest when there is no artist to bill it to, rather than promoting it', () => {
	// `unparsed` means the artist could not be named. A featured guest is still not the artist, so
	// publishing it would be a known-wrong value.
	const p = parseTrackTitle('Some Song (feat. Guest)', '7clouds');
	expect(p.by).toBe('unparsed');
	expect(p.artist).toBeNull();
	expect(p.artistFull).toBeNull();
	expect(p.title).toBe('Some Song');
});

it('a guest credit inside the TITLE belongs to the billing: does not disturb a recording qualifier that identifies a DIFFERENT take', () => {
	// (Live), (Remix), (Instrumental) name another recording; dropping them merges two songs.
	expect(parseTrackTitle('A - T (Live)', 'A').title).toBe('T (Live)');
	expect(parseTrackTitle('A - T (Instrumental)', 'A').title).toBe('T (Instrumental)');
});
