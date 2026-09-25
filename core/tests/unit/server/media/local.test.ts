// Done-when: FTS returns ranked local matches.
import { test, expect } from 'bun:test';
import { ftsPrefixQuery, LocalLibrary } from '$lib/server/media/local';
import { resultToMedia } from '$lib/server/media/resolver';
import { isPlayable } from '$lib/contract';

function lib() {
	const l = new LocalLibrary();
	l.index([
		{ sourceRef: 'a.mp4', title: 'Bohemian Rhapsody', artist: 'Queen', durationSec: 355 },
		{ sourceRef: 'b.mp4', title: 'Dancing Queen', artist: 'ABBA', durationSec: 231 },
		{ sourceRef: 'c.mp4', title: 'Take On Me', artist: 'a-ha', durationSec: 225 },
		{ sourceRef: 'd.mp4', title: 'Killer Queen', artist: 'Queen', durationSec: 180 }
	]);
	return l;
}

test('FTS matches by title term', async () => {
	const r = await lib().search('bohemian', 10);
	expect(r).toHaveLength(1);
	expect(r[0]!.title).toBe('Bohemian Rhapsody');
	expect(r[0]!.source).toBe('local');
});

test('FTS matches by artist and ranks all hits', async () => {
	const r = await lib().search('queen', 10);
	const titles = r.map((x) => x.title).sort();
	// 3 hits: Bohemian Rhapsody (artist), Dancing Queen (title), Killer Queen (title+artist)
	expect(titles).toEqual(['Bohemian Rhapsody', 'Dancing Queen', 'Killer Queen']);
});

test('prefix match: partial term finds results', async () => {
	const r = await lib().search('danc', 10);
	expect(r[0]!.title).toBe('Dancing Queen');
});

test('limit is respected', async () => {
	const r = await lib().search('queen', 2);
	expect(r.length).toBeLessThanOrEqual(2);
});

test('empty query returns nothing', async () => {
	expect(await lib().search('   ', 10)).toEqual([]);
});

// ── a punctuated query must not empty the local library ──────────────────────
// Terms went into FTS5 UNQUOTED, so a metacharacter was parsed as syntax: `spirit (live)` raised
// `fts5: syntax error near "("` and `nirvana: mtv` raised `no such column: nirvana`. Both threw out of
// `.all()`, and /api/search's `safeSearch` treats a throwing resolver as a dead source — so every local
// song vanished from a merged search and read as "you own nothing" rather than as a failure.
test('THE BUG: a term containing FTS5 syntax still matches instead of throwing', async () => {
	// Its own fixture, because the shared one has no parenthesised title and the bracket has to land on a
	// real token to prove the term was SEARCHED rather than merely survived.
	const l = new LocalLibrary();
	l.index([{ sourceRef: 'x.mp4', title: 'Smells Like Teen Spirit (Live)', artist: 'Nirvana', durationSec: 301 }]);
	expect((await l.search('spirit (live)', 10)).map((x) => x.title)).toEqual(['Smells Like Teen Spirit (Live)']);
});

test('THE BUG: a colon is a literal, not a column filter', async () => {
	// `queen: greatest` once parsed `queen` as a column name. Nothing matches `greatest`, so the honest
	// answer is no rows — the point is that it ANSWERS.
	expect(await lib().search('queen: greatest', 10)).toEqual([]);
});

test('an apostrophe is indexed, not stripped', async () => {
	const l = new LocalLibrary();
	l.index([{ sourceRef: 'x.mp4', title: "Don't Stop Me Now", artist: 'Queen', durationSec: 210 }]);
	// Stripping it built `dont*`, which cannot match the `don` + `t` tokens FTS5 actually indexes.
	expect((await l.search("don't", 10)).map((x) => x.title)).toEqual(["Don't Stop Me Now"]);
});

test('a term with no indexable character is dropped rather than quoted into an empty phrase', async () => {
	// `""` is itself an FTS5 syntax error, so these must reduce to "no query" and return nothing.
	for (const q of ['(((', '!!!', '-', '...']) expect(await lib().search(q, 10)).toEqual([]);
});

test('punctuation around a real term does not cost the match', async () => {
	expect((await lib().search('(bohemian)', 10)).map((x) => x.title)).toEqual(['Bohemian Rhapsody']);
});

test('ftsPrefixQuery puts the prefix star OUTSIDE the quotes, or it is just an asterisk to tokenize', () => {
	expect(ftsPrefixQuery('teen spirit')).toBe('"teen"* "spirit"*');
	expect(ftsPrefixQuery('a "b" c')).toBe('"a"* """b"""* "c"*');
	expect(ftsPrefixQuery('   ')).toBe('');
});

test('resultToMedia leaves a local file UNPROCESSED, so it is not playable yet', async () => {
	const r = (await lib().search('take', 1))[0]!;
	const m = resultToMedia('id1', r);
	expect(m.stemStatus).toBe('none');
	expect(isPlayable(m)).toBe(false); // a local file still needs separating before anyone can sing it
	expect(m.source).toBe('local');
	expect(m.sourceRef).toBe('c.mp4');
});

// ── never advertise a track whose file is missing ─────────────────────────────
// The dev seed listed four library demos with no files behind them. They were searchable and
// processable, and a process failed 3x on `ffmpeg exited 254: No such file or directory`, then left the
// song pinned in the phone's "processing" list permanently.
import { presentTracks, type LocalTrack } from '$lib/server/media/local';

const track = (ref: string): LocalTrack => ({ sourceRef: ref, title: ref, durationSec: 1 });

test('presentTracks drops tracks with no file on disk', () => {
	const tracks = [track('library/a.mp4'), track('library/missing.mp4'), track('library/c.mp4')];
	const kept = presentTracks(tracks, (ref) => ref !== 'library/missing.mp4');
	expect(kept.map((t) => t.sourceRef)).toEqual(['library/a.mp4', 'library/c.mp4']);
});

test('presentTracks keeps everything when every file is present', () => {
	const tracks = [track('library/a.mp4'), track('library/b.mp4')];
	expect(presentTracks(tracks, () => true)).toHaveLength(2);
});

test('THE BUG: none present → index nothing rather than four unplayable songs', () => {
	const tracks = [track('library/a.mp4'), track('library/b.mp4')];
	expect(presentTracks(tracks, () => false)).toEqual([]);
});
