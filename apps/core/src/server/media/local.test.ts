// Done-when: FTS returns ranked local matches.
import { test, expect } from 'bun:test';
import { LocalLibrary } from './local';
import { resultToMedia } from './resolver';

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

test('resultToMedia maps local -> playMode file', async () => {
	const r = (await lib().search('take', 1))[0]!;
	const m = resultToMedia('id1', r);
	expect(m.playMode).toBe('file');
	expect(m.source).toBe('local');
	expect(m.sourceRef).toBe('c.mp4');
});

// ── never advertise a track whose file is missing ─────────────────────────────
// The dev seed listed four library demos with no files behind them. They were searchable and
// cookable, and a cook failed 3x on `ffmpeg exited 254: No such file or directory`, then left the
// song pinned in the phone's "cooking" list permanently.
import { presentTracks, type LocalTrack } from './local';

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
