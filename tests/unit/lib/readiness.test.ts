import { EMPTY_SONG_PROFILE, type Media, type MediaStatus } from '$lib/contract';
import {
	canProcess,
	displayReadiness,
	entryPlayable,
	nextPlayableEntryId,
	processingGroupIds,
	queueCardKind,
	readinessOf,
	readyEmptyState
} from '$lib/readiness';
import { isEntryReady } from '$lib/server/rotation';
import { expect, test } from 'bun:test';
// The client's readiness view must agree with the server's classification and let a live media:status win
// over a stale catalog copy, or tapping Karaoke leaves the row untouched until the next full sync.

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
	// Separated, mid-align: neither 'ready' nor 'queued', which is the case that falls through to
	// 'unacquired' and shows a Sing button on an already-separated song.
	m({
		stemStatus: 'ready',
		lyricsStatus: 'queued',
		instrumentalRef: 'derived/stems/i-instrumental.flac',
		songProfile: EMPTY_SONG_PROFILE
	})
];

test('THE BUG: a separated song mid-align reads as processing, not unacquired', () => {
	// Past the stems gate but not finished: matching neither 'ready' nor stemStatus==='queued' falls
	// through to 'unacquired'.
	const midAlign = m({
		stemStatus: 'ready',
		lyricsStatus: 'queued',
		instrumentalRef: 'derived/stems/i-instrumental.flac',
		// The stems job emits the profile with the instrumental, so without it the stems gate is not done
		// and this reads as unacquired rather than processing.
		songProfile: EMPTY_SONG_PROFILE
	});
	expect(readinessOf(midAlign)).toBe('processing');
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
	// Falling through to the catalog reports 'unacquired', or 'processing' while stemStatus is mid-flight, which is what
	// makes a dead process read "Making karaoke… 0%" forever with a four-second toast as the only failure signal.
	expect(displayReadiness(m(), { status: 'failed' })).toBe('failed');
});

test('a failed process on an already-singable song is not a failure the guest needs', () => {
	// A dead lyrics upgrade on a processed song is still fully singable: the gates decide singability.
	const processed = m({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'ready'
	});
	expect(displayReadiness(processed, { status: 'failed' })).toBe('ready');
});

test('an unacquired or FAILED song can be processed; one in flight or done cannot', () => {
	expect(canProcess(m(), 'unacquired')).toBe(true);
	// A failed process settles back to un-processed server-side, so Sing is a real action again.
	expect(canProcess(m(), 'failed')).toBe(true);
	expect(canProcess(m(), 'ready')).toBe(false);
	expect(canProcess(m(), 'processing')).toBe(false);
});

// The Ready group is query-scoped while a search is active, so a query matching none of the library
// empties the group — and the copy must not then announce that the library itself is empty. Reported from
// a real party as "it clears the remote of the downloaded library".
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
	expect(s.message).toContain('zzzz'); // names what was searched
	// The count lives on the control that acts on it ("Show all 5", `showAllCount` below), not in the sentence. Both
	// halves stay pinned: the message must not claim there are none, and the count must reach the surface.
	expect(s.showAllCount).toBe(5); // and offers the one tap back to the library
});

test('singular wording for a one-song library', () => {
	// The singular/plural agreement claim lives on the branch that still names a count; the searching
	// branch names none, and "Show all 1" needs no noun.
	const s = readyEmptyState({ searchActive: false, libraryCount: 1 });
	expect(s.message).toContain('1 karaoke song ');
	expect(s.message).not.toContain('songs');
});

test('a blank query while searchActive still reads sensibly (no empty quotes)', () => {
	const s = readyEmptyState({ searchActive: true, libraryCount: 3, query: '   ' });
	expect(s.message).toContain('matches this search');
	expect(s.message).not.toContain('““');
	expect(s.showAllCount).toBe(3);
});

// Up-next must match what the server will actually play. The server's nextPlayable() skips an entry whose
// stems are still processing, so labelling the FIRST queued row promises a song the TV skips past.

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
	// A song is finished when every required step is done, not when the instrumental exists: rotation
	// holds its slot and moves on to whoever IS finished.
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

// A cancel is not a failure. Removing a processing song settles it back to un-processed exactly like a
// terminal failure, so the two need the SAME store effect and OPPOSITE copy: reusing 'failed' tells a
// guest who removed a song "Couldn't make karaoke", a lie about their own action.

test('a canceled process reads from the catalog, not as a failure', () => {
	expect(displayReadiness(m(), { status: 'canceled' })).toBe('unacquired');
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

// The singer's own queue card must say when the process died. Choosing between the progress card and a plain waiting
// row on an "is it in flight" test renders a dead turn byte-for-byte as a turn about to play, while nextPlayable holds
// its slot forever. Expected values are literals, not re-derived through displayReadiness the way the code is.
test('a live failed status selects the FAILED card, not a plain waiting row', () => {
	// Media settled back to un-processed after a dead process, live status failed.
	expect(queueCardKind(m({ stemStatus: 'none' }), { status: 'failed' })).toBe('failed');
});

test('a process in flight still selects the processing card', () => {
	expect(queueCardKind(m({ stemStatus: 'queued' }), { status: 'separating' })).toBe('processing');
	expect(queueCardKind(m(), { status: 'queued' })).toBe('processing');
});

test('a settled or absent status leaves a plain waiting row', () => {
	// ready and canceled are terminal-and-settled: an ordinary turn, no process card.
	expect(queueCardKind(m(), { status: 'ready' })).toBe('plain');
	expect(queueCardKind(m(), { status: 'canceled' })).toBe('plain');
	expect(queueCardKind(m(), undefined)).toBe('plain');
});

test('a failed lyrics upgrade on a still-singable song is NOT marked broken', () => {
	// The case a raw `status === failed` test gets wrong: the song is fully processed and singable, so a failed lyrics
	// upgrade must not label a turn that WILL play as dead. Deferred to displayReadiness, which reads the catalog.
	const singable = m({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'ready',
		songProfile: EMPTY_SONG_PROFILE
	});
	expect(displayReadiness(singable, { status: 'failed' })).toBe('ready'); // the premise
	expect(queueCardKind(singable, { status: 'failed' })).toBe('plain'); // so: plain, not failed
});

// A PROCESSING song must obey the search-match filter. Re-deriving the group from the whole live status
// map and the whole catalog with no reference to the query shows a song someone else is processing under
// an UNRELATED search. `processingGroupIds` is scoped to the query when searching.

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: `ref-${id}`,
	title: id,
	durationSec: 200,
	stemStatus: 'queued', // in flight → catalog classifies it as processing
	...over
});

// The trap: genuinely processing (someone else started it) so it is in the live status map and the
// catalog, but it does NOT match the query, so `processingResults` does not contain it.
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
	// The wire returned only the query-matching processing song; the other was processing but did not
	// match, so partitionSearch excluded it.
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
	// With no search box the escape hatch holds: a process you started stays visible from both the live
	// status map and the catalog, regardless of `processingResults`.
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
