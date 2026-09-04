// The classifier's test cases are the REAL yt-dlp search results for "bohemian rhapsody" and
// "mr brightside", captured from the binary (2026.08.19) rather than invented — including the two
// that motivated the feature: a movie trailer and a 22-minute concert rip sitting in a list of songs.
import { test, it, expect, describe } from 'bun:test';
import {
	classifyVideoKind,
	durationHint,
	isUnusualSongDuration,
	formatDuration,
	formatViewCount,
	VIDEO_KIND_LABEL,
	SONG_MAX_SEC,
	SONG_MIN_SEC
} from './video-kind';

describe('classifyVideoKind — the real search results', () => {
	it('"Queen – Bohemian Rhapsody (Official Video Remastered)" → official', () => {
		expect(classifyVideoKind('Queen – Bohemian Rhapsody (Official Video Remastered)')).toBe('official');
	});

	it('"Queen - Bohemian Rhapsody (Lyrics)" → lyric', () => {
		expect(classifyVideoKind('Queen - Bohemian Rhapsody (Lyrics)')).toBe('lyric');
	});

	it('"Queen — Bohemian Rhapsody (Sub. Español / Lyrics)" → lyric', () => {
		expect(classifyVideoKind('Queen — Bohemian Rhapsody (Sub. Español / Lyrics)')).toBe('lyric');
	});

	it('"Queen - Bohemian Rhapsody (Live Aid 1985)" → live', () => {
		expect(classifyVideoKind('Queen - Bohemian Rhapsody (Live Aid 1985)')).toBe('live');
	});

	it('"Bohemian Rhapsody 2018 BONUS Complete Live Aid Performance 1080p BluRay" → live', () => {
		expect(classifyVideoKind('Bohemian Rhapsody 2018 BONUS Complete Live Aid Performance 1080p BluRay')).toBe('live');
	});

	// THE motivating case: a movie trailer, 2:31 (an ordinary song length), on a verified channel.
	it('"Bohemian Rhapsody | Official Trailer [HD] | 20th Century FOX" → suspect, NOT official', () => {
		expect(classifyVideoKind('Bohemian Rhapsody | Official Trailer [HD] | 20th Century FOX')).toBe('suspect');
	});

	it('"Mr. Brightside HQ (The Killers)" → unknown, because nothing in it claims anything', () => {
		expect(classifyVideoKind('Mr. Brightside HQ (The Killers)')).toBe('unknown');
	});
});

describe('precedence: suspect > live > lyric > official', () => {
	it('suspect beats official — "Official Trailer" must never read as "Official video"', () => {
		expect(classifyVideoKind('Song Name (Official Trailer)')).toBe('suspect');
	});

	it('suspect beats live and lyric too', () => {
		expect(classifyVideoKind('Band - Song (Live at Wembley) Interview')).toBe('suspect');
		expect(classifyVideoKind('Band - Song (Lyrics) Behind The Scenes')).toBe('suspect');
	});

	// live identifies a different RECORDING (arrangement, length, key); lyric only describes the
	// visuals — so when a title says both, live is the more consequential answer for a singer.
	it('live beats lyric', () => {
		expect(classifyVideoKind('Band - Song (Live at Wembley) [Lyrics]')).toBe('live');
	});

	it('lyric beats official', () => {
		expect(classifyVideoKind('Band - Song (Official Video) (Lyrics)')).toBe('lyric');
	});
});

describe('word boundaries — the over-match traps', () => {
	it('"live" inside another word is not a live recording', () => {
		expect(classifyVideoKind('Olive Tree - Delivery Boy (Official Video)')).toBe('official');
		expect(classifyVideoKind('Bon Jovi - Livin On A Prayer (Official Video)')).toBe('official');
	});

	// A bare "(Live)" with no venue is the common real form, so it must match — but only inside
	// brackets, which is what keeps "Live Your Life" from matching.
	it('a bracketed bare (Live) matches; an unbracketed free word does not', () => {
		expect(classifyVideoKind('Band - Song (Live)')).toBe('live');
		expect(classifyVideoKind('Band - Song [Live]')).toBe('live');
		expect(classifyVideoKind('T.I. - Live Your Life ft. Rihanna')).toBe('unknown');
	});

	it('an empty or junk title is unknown, never a crash', () => {
		expect(classifyVideoKind('')).toBe('unknown');
		expect(classifyVideoKind('!!! ??? ...')).toBe('unknown');
	});
});

test('unknown carries no label, so no empty chip can render', () => {
	expect(VIDEO_KIND_LABEL.unknown).toBeNull();
	for (const kind of ['suspect', 'live', 'lyric', 'official'] as const) {
		expect(VIDEO_KIND_LABEL[kind]).toBeTruthy();
	}
});

// A first-time guest read "Not a song?" as a question being put TO them. A chip states; it does not ask.
test('no label is phrased as a question', () => {
	for (const label of Object.values(VIDEO_KIND_LABEL)) {
		if (label) expect(label).not.toContain('?');
	}
});

describe('durationHint — the red badge, in words', () => {
	it('names which way the duration is wrong', () => {
		expect(durationHint(21 * 60 + 56)).toBe('Longer than a song');
		expect(durationHint(30)).toBe('Shorter than a song');
	});

	it('says nothing about an ordinary or unknown duration', () => {
		expect(durationHint(224)).toBeNull();
		expect(durationHint(0)).toBeNull();
		expect(durationHint(undefined)).toBeNull();
	});

	// The badge colour and the chip must never disagree — they are the same judgement.
	it('agrees with isUnusualSongDuration for every case', () => {
		for (const d of [undefined, 0, 30, 74, 75, 224, 360, 480, 481, 1316]) {
			expect(durationHint(d) !== null).toBe(isUnusualSongDuration(d));
		}
	});
});

describe('isUnusualSongDuration — a threshold, not a parse', () => {
	it('flags the 21:56 concert rip and a 30-second clip', () => {
		expect(isUnusualSongDuration(21 * 60 + 56)).toBe(true);
		expect(isUnusualSongDuration(30)).toBe(true);
	});

	it('passes ordinary songs, including a 6:00 Bohemian Rhapsody', () => {
		expect(isUnusualSongDuration(360)).toBe(false);
		expect(isUnusualSongDuration(224)).toBe(false);
		expect(isUnusualSongDuration(SONG_MAX_SEC)).toBe(false);
		expect(isUnusualSongDuration(SONG_MIN_SEC)).toBe(false);
	});

	// A local file and a live stream both report 0. Colouring those would cry wolf on every one.
	it('an absent or zero duration is NOT unusual', () => {
		expect(isUnusualSongDuration(0)).toBe(false);
		expect(isUnusualSongDuration(undefined)).toBe(false);
	});
});

describe('formatDuration', () => {
	it('renders mm:ss, zero-padding seconds only', () => {
		expect(formatDuration(224)).toBe('3:44');
		expect(formatDuration(360)).toBe('6:00');
		expect(formatDuration(1316)).toBe('21:56');
		expect(formatDuration(9)).toBe('0:09');
	});

	it('adds an hour part with padded minutes past 60 minutes', () => {
		expect(formatDuration(3723)).toBe('1:02:03');
	});

	it('returns empty for absent/zero so the badge hides instead of showing 0:00', () => {
		expect(formatDuration(0)).toBe('');
		expect(formatDuration(undefined)).toBe('');
	});
});

describe('formatViewCount — the tiebreaker between two uploads of one song', () => {
	it('compacts the real numbers from the search', () => {
		expect(formatViewCount(2_093_310_583)).toBe('2.1B');
		expect(formatViewCount(306_017_891)).toBe('306M');
		expect(formatViewCount(3_105_203)).toBe('3.1M');
		expect(formatViewCount(265_947)).toBe('266K');
		expect(formatViewCount(981)).toBe('981');
	});

	it('drops a trailing .0 rather than rendering "2.0M"', () => {
		expect(formatViewCount(2_000_000)).toBe('2M');
		expect(formatViewCount(1_000)).toBe('1K');
	});

	// "0 views" and "we never learned a view count" must not look alike on the row.
	it('returns empty for undefined so the chip is omitted, but renders a real 0', () => {
		expect(formatViewCount(undefined)).toBe('');
		expect(formatViewCount(0)).toBe('0');
	});

	it('refuses garbage instead of rendering NaN', () => {
		expect(formatViewCount(Number.NaN)).toBe('');
		expect(formatViewCount(-5)).toBe('');
	});
});
