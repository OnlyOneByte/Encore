// The client's readiness view must agree with the server's classification, and must let a live
// media:status win over a stale catalog copy — otherwise tapping "✨ Karaoke" leaves the row looking
// untouched until the next full sync.
import { test, expect } from 'bun:test';
import { readinessOf, displayReadiness, canCook, readyEmptyState, queueCardKind } from '$lib/readiness';
import { readinessOf as serverReadinessOf } from '$lib/server/media/readiness';
import type { Media } from '$lib/contract';
import { EMPTY_SONG_PROFILE } from '$lib/contract';

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
	m({
		stemStatus: 'ready',
		lyricsStatus: 'ready',
		instrumentalRef: 'derived/stems/i-instrumental.flac',
		songProfile: EMPTY_SONG_PROFILE
	}),
	m({ stemStatus: 'queued' }),
	m({ source: 'local', stemStatus: 'none' }),
	m({ stemStatus: 'ready' }), // ready status, no artifact — must classify the same on both sides
	// Separated, now mid-align: stems done but lyrics still queued. Neither 'ready' nor 'queued' — the
	// case that used to fall through to 'unacquired' and show a Sing button on a separated song.
	m({
		stemStatus: 'ready',
		lyricsStatus: 'queued',
		instrumentalRef: 'derived/stems/i-instrumental.flac',
		songProfile: EMPTY_SONG_PROFILE
	})
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
	expect(canCook(midAlign, readinessOf(midAlign))).toBe(false); // no Sing/cook button on a separated song
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
	expect(canCook(m(), 'unacquired')).toBe(true);
	// The retry path. A failed cook settles back to un-cooked server-side, so offering Sing again is a
	// real action rather than a button that answers "already cooked".
	expect(canCook(m(), 'failed')).toBe(true);
	expect(canCook(m(), 'ready')).toBe(false);
	expect(canCook(m(), 'cooking')).toBe(false);
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
import { entryPlayable, nextPlayableEntryId } from '$lib/readiness';
import { isEntryReady } from '$lib/server/rotation/index';

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
	const noLyrics = m({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/i-instrumental.flac',
		songProfile: EMPTY_SONG_PROFILE
	});
	expect(entryPlayable(noLyrics)).toBe(false);
	expect(entryPlayable({ ...noLyrics, lyricsStatus: 'ready' })).toBe(true);
});

test('unknown media is not playable (matches the server returning false)', () => {
	expect(entryPlayable(undefined)).toBe(false);
});

test('THE BUG: up-next skips a cooking first entry and names the first READY one', () => {
	const cook = m({ id: 'cooking', stemStatus: 'queued' });
	const ready = m({
		id: 'ready',
		stemStatus: 'ready',
		lyricsStatus: 'ready',
		instrumentalRef: 'derived/stems/i-instrumental.flac',
		songProfile: EMPTY_SONG_PROFILE
	});
	const byId = new Map([
		[cook.id, cook],
		[ready.id, ready]
	]);
	const queued = [entry('e1', 'cooking'), entry('e2', 'ready')];

	const id = nextPlayableEntryId(
		queued,
		(k) => byId.get(k),
		() => undefined
	);
	expect(id).toBe('e2'); // NOT 'e1' — that one is still separating and yields its turn
});

test('up-next is the first entry when it is already playable', () => {
	const ready = m({
		id: 'ready',
		stemStatus: 'ready',
		lyricsStatus: 'ready',
		instrumentalRef: 'derived/stems/i-instrumental.flac',
		songProfile: EMPTY_SONG_PROFILE
	});
	const byId = new Map([[ready.id, ready]]);
	const queued = [entry('e1', 'ready'), entry('e2', 'ready')];
	expect(
		nextPlayableEntryId(
			queued,
			(k) => byId.get(k),
			() => undefined
		)
	).toBe('e1');
});

test('nothing playable → no up-next (the whole queue is cooking)', () => {
	const cook = m({ id: 'cooking', stemStatus: 'queued' });
	const byId = new Map([[cook.id, cook]]);
	const queued = [entry('e1', 'cooking'), entry('e2', 'cooking')];
	expect(
		nextPlayableEntryId(
			queued,
			(k) => byId.get(k),
			() => undefined
		)
	).toBeNull();
});

// ── a cancel is not a failure ──────────────────────────────────────────────────────────────────
// Removing a cooking song settles it back to un-cooked exactly like a terminal failure, so the two
// need the SAME store effect and OPPOSITE copy. Reusing 'failed' for a cancel made the phone tell a
// guest who deliberately removed a song "Couldn't make karaoke" — a lie about their own action.

test('a canceled cook reads from the catalog, not as a failure', () => {
	expect(displayReadiness(m(), { status: 'canceled' })).toBe('unacquired');
	// The distinction that matters: same input shape, different verdict.
	expect(displayReadiness(m(), { status: 'failed' })).toBe('failed');
});

test('a canceled cook offers Sing again rather than a failure chip', () => {
	expect(canCook(m(), displayReadiness(m(), { status: 'canceled' }))).toBe(true);
});

test('a canceled status leaves playability to the catalog, like failed', () => {
	const cooked = m({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'ready'
	});
	expect(entryPlayable(cooked, { status: 'canceled' })).toBe(true);
	expect(entryPlayable(m(), { status: 'canceled' })).toBe(false);
});

// ── F2: the singer's own queue card must say when the cook died ──────────────────────────────
// A rotation entry chose between the cook-progress card and a plain waiting row on an "is it in
// flight" test, and a terminally failed cook is not in flight — so a dead turn rendered
// byte-for-byte as a turn about to play, with nothing saying the cook failed while nextPlayable held
// its slot forever. queueCardKind selects the card, and MUST route a failed live status to a failed
// card. Expected values are hard-coded, not derived from displayReadiness the same way the code is.
test('a live failed status selects the FAILED card, not a plain waiting row', () => {
	// The exact reported state: media settled back to un-cooked (stemStatus none) after a dead cook,
	// live status failed. On base this returned a plain row.
	expect(queueCardKind(m({ stemStatus: 'none' }), { status: 'failed' })).toBe('failed');
});

test('a cook in flight still selects the cooking card', () => {
	expect(queueCardKind(m({ stemStatus: 'queued' }), { status: 'separating' })).toBe('cooking');
	expect(queueCardKind(m(), { status: 'queued' })).toBe('cooking');
});

test('a settled or absent status leaves a plain waiting row', () => {
	// ready and canceled are terminal-and-settled: an ordinary turn again, no cook card.
	expect(queueCardKind(m(), { status: 'ready' })).toBe('plain');
	expect(queueCardKind(m(), { status: 'canceled' })).toBe('plain');
	// no live status at all — the common case, a plain queued turn.
	expect(queueCardKind(m(), undefined)).toBe('plain');
});

test('a failed lyrics upgrade on a still-singable song is NOT marked broken', () => {
	// The one case a raw status===failed test gets wrong: the song is fully cooked and singable, and a
	// failed lyrics upgrade must not label a turn that WILL play as a dead one. Deferred to
	// displayReadiness, which reads the catalog, so this stays plain.
	const singable = m({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'ready',
		songProfile: EMPTY_SONG_PROFILE
	});
	expect(displayReadiness(singable, { status: 'failed' })).toBe('ready'); // the premise
	expect(queueCardKind(singable, { status: 'failed' })).toBe('plain'); // so: plain, not failed
});
