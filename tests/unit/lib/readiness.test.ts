import { EMPTY_SONG_PROFILE, Media, MediaStatus } from '$lib/contract';
import { canProcess, displayReadiness, entryPlayable, nextPlayableEntryId, processingGroupIds, queueCardKind, readinessOf, readyEmptyState } from '$lib/readiness';
import { readinessOf as serverReadinessOf } from '$lib/server/media/readiness';
import { isEntryReady } from '$lib/server/rotation/index';
import { expect, test } from 'bun:test';
// The client's readiness view must agree with the server's classification, and must let a live
// media:status win over a stale catalog copy — otherwise tapping "✨ Karaoke" leaves the row looking
// untouched until the next full sync.





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

test('THE BUG: a separated song mid-align reads as processing, not unacquired', () => {
	// stems ready + lyrics queued is past the stems gate but not finished. Before the gate-driven fix
	// this matched neither 'ready' nor stemStatus==='queued', fell through to 'unacquired', and showed
	// a Sing button on an already-separated song.
	const midAlign = m({
		stemStatus: 'ready',
		lyricsStatus: 'queued',
		instrumentalRef: 'derived/stems/i-instrumental.flac',
		// The stems job emits the profile with the instrumental, so a real mid-align song already has it;
		// without it the stems gate is not done and this would read as unacquired, not processing.
		songProfile: EMPTY_SONG_PROFILE
	});
	expect(readinessOf(midAlign)).toBe('processing');
	expect(serverReadinessOf(midAlign)).toBe('processing');
	expect(canProcess(midAlign, readinessOf(midAlign))).toBe(false); // no Sing/process button on a separated song
});

test('a live media:status wins over the catalog copy (the row responds to the tap at once)', () => {
	const fresh = m();
	expect(displayReadiness(fresh)).toBe('unacquired');
	expect(displayReadiness(fresh, { status: 'queued' })).toBe('processing');
	expect(displayReadiness(fresh, { status: 'separating' })).toBe('processing');
	expect(displayReadiness(fresh, { status: 'ready' })).toBe('ready');
});

test('a failed process READS as failed, so the singer learns the process died', () => {
	// This used to fall through to the catalog and report 'unacquired' — or, while stemStatus was still
	// mid-flight, 'processing', which is what made a dead process read "Making karaoke… 0%" forever. The only
	// failure signal was a four-second toast; look away and the information was gone for good.
	expect(displayReadiness(m(), { status: 'failed' })).toBe('failed');
});

test('a failed process on an already-singable song is not a failure the guest needs', () => {
	// A dead lyrics upgrade on a processed song: still fully singable, so reporting failure would be
	// alarming and wrong. The gates decide singability, as everywhere else.
	const processed = m({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'ready'
	});
	expect(displayReadiness(processed, { status: 'failed' })).toBe('ready');
});

test('an unacquired or FAILED song can be processed; one in flight or done cannot', () => {
	expect(canProcess(m(), 'unacquired')).toBe(true);
	// The retry path. A failed process settles back to un-processed server-side, so offering Sing again is a
	// real action rather than a button that answers "already processed".
	expect(canProcess(m(), 'failed')).toBe(true);
	expect(canProcess(m(), 'ready')).toBe(false);
	expect(canProcess(m(), 'processing')).toBe(false);
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
// whose stems are still processing, so whenever row 0 was processing the phone promised a song the TV was
// about to skip past. These pin the agreement.


const entry = (id: string, mediaId: string) => ({ id, mediaId });

test('entryPlayable agrees with the server isEntryReady for every media shape', () => {
	for (const c of cases) {
		const byId = new Map([[c.id, c]]);
		expect(entryPlayable(c)).toBe(isEntryReady({ mediaId: c.id } as never, byId));
	}
});

test('a live processing status beats a catalog copy that still says ready', () => {
	expect(entryPlayable(m({ stemStatus: 'ready' }), { status: 'separating' })).toBe(false);
	expect(entryPlayable(m({ stemStatus: 'queued' }), { status: 'ready' })).toBe(true);
});

test('separated but lyrics never ran is NOT playable — the gate waits for the whole process', () => {
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

test('THE BUG: up-next skips a processing first entry and names the first READY one', () => {
	const proc = m({ id: 'processing', stemStatus: 'queued' });
	const ready = m({
		id: 'ready',
		stemStatus: 'ready',
		lyricsStatus: 'ready',
		instrumentalRef: 'derived/stems/i-instrumental.flac',
		songProfile: EMPTY_SONG_PROFILE
	});
	const byId = new Map([
		[proc.id, proc],
		[ready.id, ready]
	]);
	const queued = [entry('e1', 'processing'), entry('e2', 'ready')];

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

test('nothing playable → no up-next (the whole queue is processing)', () => {
	const proc = m({ id: 'processing', stemStatus: 'queued' });
	const byId = new Map([[proc.id, proc]]);
	const queued = [entry('e1', 'processing'), entry('e2', 'processing')];
	expect(
		nextPlayableEntryId(
			queued,
			(k) => byId.get(k),
			() => undefined
		)
	).toBeNull();
});

// ── a cancel is not a failure ──────────────────────────────────────────────────────────────────
// Removing a processing song settles it back to un-processed exactly like a terminal failure, so the two
// need the SAME store effect and OPPOSITE copy. Reusing 'failed' for a cancel made the phone tell a
// guest who deliberately removed a song "Couldn't make karaoke" — a lie about their own action.

test('a canceled process reads from the catalog, not as a failure', () => {
	expect(displayReadiness(m(), { status: 'canceled' })).toBe('unacquired');
	// The distinction that matters: same input shape, different verdict.
	expect(displayReadiness(m(), { status: 'failed' })).toBe('failed');
});

test('a canceled process offers Sing again rather than a failure chip', () => {
	expect(canProcess(m(), displayReadiness(m(), { status: 'canceled' }))).toBe(true);
});

test('a canceled status leaves playability to the catalog, like failed', () => {
	const processed = m({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'ready'
	});
	expect(entryPlayable(processed, { status: 'canceled' })).toBe(true);
	expect(entryPlayable(m(), { status: 'canceled' })).toBe(false);
});

// ── F2: the singer's own queue card must say when the process died ──────────────────────────────
// A rotation entry chose between the process-progress card and a plain waiting row on an "is it in
// flight" test, and a terminally failed process is not in flight — so a dead turn rendered
// byte-for-byte as a turn about to play, with nothing saying the process failed while nextPlayable held
// its slot forever. queueCardKind selects the card, and MUST route a failed live status to a failed
// card. Expected values are hard-coded, not derived from displayReadiness the same way the code is.
test('a live failed status selects the FAILED card, not a plain waiting row', () => {
	// The exact reported state: media settled back to un-processed (stemStatus none) after a dead proc,
	// live status failed. On base this returned a plain row.
	expect(queueCardKind(m({ stemStatus: 'none' }), { status: 'failed' })).toBe('failed');
});

test('a process in flight still selects the processing card', () => {
	expect(queueCardKind(m({ stemStatus: 'queued' }), { status: 'separating' })).toBe('processing');
	expect(queueCardKind(m(), { status: 'queued' })).toBe('processing');
});

test('a settled or absent status leaves a plain waiting row', () => {
	// ready and canceled are terminal-and-settled: an ordinary turn again, no process card.
	expect(queueCardKind(m(), { status: 'ready' })).toBe('plain');
	expect(queueCardKind(m(), { status: 'canceled' })).toBe('plain');
	// no live status at all — the common case, a plain queued turn.
	expect(queueCardKind(m(), undefined)).toBe('plain');
});

test('a failed lyrics upgrade on a still-singable song is NOT marked broken', () => {
	// The one case a raw status===failed test gets wrong: the song is fully processed and singable, and a
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

/* ─────────────────────────────────────────────────────────────────────────────
 * Merged in from `processing-group-query-scope.test.ts`.
 *
 * It was a satellite: a separate file named for ONE behaviour of the module this file already
 * covers. Several files about one module tell a reader nothing about which holds what, so finding
 * where a behaviour is pinned meant opening all of them. The tests are unchanged.
 * ───────────────────────────────────────────────────────────────────────────── */
// a PROCESSING song must obey the search-match filter. The Processing group used to be re-derived
// from the whole live status map and the whole catalog with no reference to the query, so a song
// someone else was processing appeared under an UNRELATED search ("I want it that way" under "never
// gonna give you up"). The server already returns a query-scoped `processing` group; the group's
// id-selection now lives in the pure `processingGroupIds` helper, scoped to the query when searching.



const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: `ref-${id}`,
	title: id,
	durationSec: 200,
	stemStatus: 'queued', // in flight → catalog classifies it as processing
	...over
});

// The "I want it that way" trap: it is genuinely processing (someone else kicked it off), so it lives
// in the live status map and the catalog — but it does NOT match the current query, so the server's
// query-matched processing group (`processingResults`) does not contain it.
const rickroll = media('rickroll', { title: 'Never Gonna Give You Up' });
const bsb = media('bsb', { title: 'I Want It That Way' });

const catalog = new Map<string, Media>([
	[rickroll.id, rickroll],
	[bsb.id, bsb]
]);
const status = new Map<string, { status: MediaStatus }>([
	[rickroll.id, { status: 'queued' }],
	[bsb.id, { status: 'queued' }]
]);

// The catalog classifier the page passes in (displayReadiness with the live status).
const readiness = (m: Media) => displayReadiness(m, status.get(m.id));

test('THE BUG: with a search active, a processing song that does NOT match the query is absent', () => {
	// The wire returned ONLY the query-matching processing song (rickroll); bsb was processing but did not
	// match "never gonna give you up", so partitionSearch excluded it.
	const ids = processingGroupIds({
		searchActive: true,
		processingResults: [rickroll],
		mediaStatus: status,
		mediaCatalog: catalog,
		readiness
	});
	expect(ids.has('bsb')).toBe(false); // ← RED on base: the old union pulled bsb in from the catalog
	expect(ids.has('rickroll')).toBe(true); // the matching process still shows — no over-correction
	expect(ids.size).toBe(1);
});

test("don't over-correct: a processing song that DOES match the query is present", () => {
	const ids = processingGroupIds({
		searchActive: true,
		processingResults: [bsb], // now searching "that way" — the server matched bsb
		mediaStatus: status,
		mediaCatalog: catalog,
		readiness
	});
	expect(ids.has('bsb')).toBe(true);
	expect(ids.has('rickroll')).toBe(false);
});

test('empty query preserves the guaranteed-visible union of every in-flight process', () => {
	// No search box → the escape-hatch requirement holds: a process you started stays visible from both
	// the live status map and the catalog, regardless of `processingResults`.
	const ids = processingGroupIds({
		searchActive: false,
		processingResults: [],
		mediaStatus: status,
		mediaCatalog: catalog,
		readiness
	});
	expect(ids.has('rickroll')).toBe(true);
	expect(ids.has('bsb')).toBe(true);
	expect(ids.size).toBe(2);
});

test('the union includes a failed process and excludes ready/canceled', () => {
	const failed = media('failed', { stemStatus: 'none' });
	const ready = media('ready', { stemStatus: 'ready' });
	const canceled = media('canceled', { stemStatus: 'none' });
	const cat = new Map<string, Media>([
		[failed.id, failed],
		[ready.id, ready],
		[canceled.id, canceled]
	]);
	const st = new Map<string, { status: MediaStatus }>([
		[failed.id, { status: 'failed' }],
		[ready.id, { status: 'ready' }],
		[canceled.id, { status: 'canceled' }]
	]);
	const ids = processingGroupIds({
		searchActive: false,
		processingResults: [],
		mediaStatus: st,
		mediaCatalog: cat,
		readiness: (m) => displayReadiness(m, st.get(m.id))
	});
	expect(ids.has('failed')).toBe(true);
	expect(ids.has('ready')).toBe(false);
	expect(ids.has('canceled')).toBe(false);
});
