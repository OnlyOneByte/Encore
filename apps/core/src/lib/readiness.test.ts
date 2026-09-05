// The client's readiness view must agree with the server's classification, and must let a live
// media:status win over a stale catalog copy — otherwise tapping "✨ Karaoke" leaves the row looking
// untouched until the next full sync.
import { test, expect } from 'bun:test';
import { readinessOf, displayReadiness, canCook, readyEmptyState } from './readiness';
import { readinessOf as serverReadinessOf } from '../server/media/readiness';
import type { Media } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

const m = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Take On Me',
	durationSec: 200,
	stemStatus: 'none',
	...over
});

const cases: Media[] = [
	m(),
	m({ stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac', songProfile: EMPTY_SONG_PROFILE }),
	m({ stemStatus: 'queued' }),
	m({ source: 'local', stemStatus: 'none' }),
	m({ stemStatus: 'ready' }), // ready status, no artifact — must classify the same on both sides
	// Separated, now mid-align: stems done but lyrics still queued. Neither 'ready' nor 'queued' — the
	// case that used to fall through to 'unacquired' and show a Sing button on a separated song.
	m({ stemStatus: 'ready', lyricsStatus: 'queued', instrumentalRef: 'derived/stems/i-instrumental.flac', songProfile: EMPTY_SONG_PROFILE })
];

test('client and server classify readiness identically for every media shape', () => {
	for (const c of cases) expect(readinessOf(c)).toBe(serverReadinessOf(c));
});

test('THE BUG: a separated song mid-align reads as cooking, not unacquired', () => {
	// stems ready + lyrics queued is past the stems gate but not finished. Before the gate-driven fix
	// this matched neither 'ready' nor stemStatus==='queued', fell through to 'unacquired', and showed
	// a Sing button on an already-separated song.
	const midAlign = m({
		stemStatus: 'ready',
		lyricsStatus: 'queued',
		instrumentalRef: 'derived/stems/i-instrumental.flac',
		// The stems job emits the profile with the instrumental, so a real mid-align song already has it;
		// without it the stems gate is not done and this would read as unacquired, not cooking.
		songProfile: EMPTY_SONG_PROFILE
	});
	expect(readinessOf(midAlign)).toBe('cooking');
	expect(serverReadinessOf(midAlign)).toBe('cooking');
	expect(canCook(readinessOf(midAlign))).toBe(false); // no Sing/cook button on a separated song
});

test('a live media:status wins over the catalog copy (the row responds to the tap at once)', () => {
	const fresh = m();
	expect(displayReadiness(fresh)).toBe('unacquired');
	expect(displayReadiness(fresh, { status: 'queued' })).toBe('cooking');
	expect(displayReadiness(fresh, { status: 'separating' })).toBe('cooking');
	expect(displayReadiness(fresh, { status: 'ready' })).toBe('ready');
});

test('a failed cook READS as failed, so the singer learns the cook died', () => {
	// This used to fall through to the catalog and report 'unacquired' — or, while stemStatus was still
	// mid-flight, 'cooking', which is what made a dead cook read "Making karaoke… 0%" forever. The only
	// failure signal was a four-second toast; look away and the information was gone for good.
	expect(displayReadiness(m(), { status: 'failed' })).toBe('failed');
});

test('a failed cook on an already-singable song is not a failure the guest needs', () => {
	// A dead lyrics upgrade on a cooked song: still fully singable, so reporting failure would be
	// alarming and wrong. The gates decide singability, as everywhere else.
	const cooked = m({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'ready'
	});
	expect(displayReadiness(cooked, { status: 'failed' })).toBe('ready');
});

test('an unacquired or FAILED song can be cooked; one in flight or done cannot', () => {
	expect(canCook('unacquired')).toBe(true);
	// The retry path. A failed cook settles back to un-cooked server-side, so offering Sing again is a
	// real action rather than a button that answers "already cooked".
	expect(canCook('failed')).toBe(true);
	expect(canCook('ready')).toBe(false);
	expect(canCook('cooking')).toBe(false);
});

// Regression (reported from a real party session): "when I hit karaoke on a song, it clears the
// remote of the downloaded library. It just says No karaoke-ready songs yet". The library was never
// cleared — the Ready group is query-scoped while a search is active, so a query matching none of the
// library emptied the group and the phone announced the library was empty. Reproduced with 5 songs
// in /api/library: the group vanished and the false copy appeared; clearing the query brought all 5
// back. These tests pin the copy to the truth.
test('a genuinely empty library keeps the original "none yet" copy', () => {
	const s = readyEmptyState({ searchActive: false, libraryCount: 0 });
	expect(s.message).toContain('No karaoke-ready songs yet');
	expect(s.showAllCount).toBeNull(); // nothing to go back to
});

test('an empty library while searching still says "none yet" (it is true)', () => {
	const s = readyEmptyState({ searchActive: true, libraryCount: 0, query: 'take on me' });
	expect(s.message).toContain('No karaoke-ready songs yet');
	expect(s.showAllCount).toBeNull();
});

test('THE BUG: a non-empty library during a search must NOT claim there are none', () => {
	const s = readyEmptyState({ searchActive: true, libraryCount: 5, query: 'zzzz' });
	expect(s.message).not.toContain('No karaoke-ready songs yet');
	expect(s.message).toContain('5');
	expect(s.message).toContain('zzzz'); // names what was searched
	expect(s.showAllCount).toBe(5); // and offers the one tap back to the library
});

test('singular wording for a one-song library', () => {
	const s = readyEmptyState({ searchActive: true, libraryCount: 1, query: 'x' });
	expect(s.message).toContain('1 karaoke song ');
	expect(s.message).not.toContain('songs');
});

test('a blank query while searchActive still reads sensibly (no empty quotes)', () => {
	const s = readyEmptyState({ searchActive: true, libraryCount: 3, query: '   ' });
	expect(s.message).toContain('match this search');
	expect(s.message).not.toContain('““');
	expect(s.showAllCount).toBe(3);
});

// ── up-next must match what the server will actually play ─────────────────────
// The phone used to label the FIRST queued row "up next". The server's nextPlayable() skips an entry
// whose stems are still cooking, so whenever row 0 was cooking the phone promised a song the TV was
// about to skip past. These pin the agreement.
import { entryPlayable, nextPlayableEntryId } from './readiness';
import { isEntryReady } from '../server/rotation/index';

const entry = (id: string, mediaId: string) => ({ id, mediaId });

test('entryPlayable agrees with the server isEntryReady for every media shape', () => {
	for (const c of cases) {
		const byId = new Map([[c.id, c]]);
		expect(entryPlayable(c)).toBe(isEntryReady({ mediaId: c.id } as never, byId));
	}
});

test('a live cooking status beats a catalog copy that still says ready', () => {
	expect(entryPlayable(m({ stemStatus: 'ready' }), { status: 'separating' })).toBe(false);
	expect(entryPlayable(m({ stemStatus: 'queued' }), { status: 'ready' })).toBe(true);
});

test('separated but lyrics never ran is NOT playable — the gate waits for the whole cook', () => {
	// The gate change: a song is finished when every required step is done, not when the instrumental
	// exists. Rotation holds its slot and moves on to whoever IS finished.
	const noLyrics = m({ stemStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac', songProfile: EMPTY_SONG_PROFILE });
	expect(entryPlayable(noLyrics)).toBe(false);
	expect(entryPlayable({ ...noLyrics, lyricsStatus: 'ready' })).toBe(true);
});

test('unknown media is not playable (matches the server returning false)', () => {
	expect(entryPlayable(undefined)).toBe(false);
});

test('THE BUG: up-next skips a cooking first entry and names the first READY one', () => {
	const cook = m({ id: 'cooking', stemStatus: 'queued' });
	const ready = m({ id: 'ready', stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac', songProfile: EMPTY_SONG_PROFILE });
	const byId = new Map([[cook.id, cook], [ready.id, ready]]);
	const queued = [entry('e1', 'cooking'), entry('e2', 'ready')];

	const id = nextPlayableEntryId(queued, (k) => byId.get(k), () => undefined);
	expect(id).toBe('e2'); // NOT 'e1' — that one is still separating and yields its turn
});

test('up-next is the first entry when it is already playable', () => {
	const ready = m({ id: 'ready', stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac', songProfile: EMPTY_SONG_PROFILE });
	const byId = new Map([[ready.id, ready]]);
	const queued = [entry('e1', 'ready'), entry('e2', 'ready')];
	expect(nextPlayableEntryId(queued, (k) => byId.get(k), () => undefined)).toBe('e1');
});

test('nothing playable → no up-next (the whole queue is cooking)', () => {
	const cook = m({ id: 'cooking', stemStatus: 'queued' });
	const byId = new Map([[cook.id, cook]]);
	const queued = [entry('e1', 'cooking'), entry('e2', 'cooking')];
	expect(nextPlayableEntryId(queued, (k) => byId.get(k), () => undefined)).toBeNull();
});
