import { EMPTY_SONG_PROFILE, type Media } from '$lib/contract';
import {
	canProcess,
	displayReadiness,
	entryPlayable,
	nextPlayableEntryId,
	processingGroupIds,
	queueCardKind,
	readinessOf,
	noRowsState,
	showsNoRows
} from '$lib/readiness';
import { isEntryReady } from '$lib/server/rotation';
import { read } from '$test';
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
	const s = noRowsState({ searchActive: false, libraryCount: 0 });
	expect(s.message).toContain('No karaoke-ready songs yet');
	expect(s.showAllCount).toBeNull(); // nothing to go back to
});

// THE ORDER OF THE TWO BRANCHES IS THE CONTRACT, and it reversed deliberately when this became the
// zero-state for the whole screen rather than for the Ready filter alone. A search that found nothing is a
// statement about THE QUERY; "no karaoke-ready songs yet" is a statement about the LIBRARY. Testing the
// library first blamed the library for a query that simply missed — which on a fresh install is every
// failed search.
test('a failed search on an EMPTY library still blames the query, not the library', () => {
	const s = noRowsState({ searchActive: true, libraryCount: 0, query: 'take on me' });
	expect(s.message).toContain('take on me');
	expect(s.message).not.toContain('No karaoke-ready songs yet');
	// Nothing to go back TO, so no control is promised.
	expect(s.showAllCount).toBeNull();
});

test('THE BUG: a non-empty library during a search must NOT claim there are none', () => {
	const s = noRowsState({ searchActive: true, libraryCount: 5, query: 'zzzz' });
	expect(s.message).not.toContain('No karaoke-ready songs yet');
	expect(s.message).toContain('zzzz'); // names what was searched
	// The count lives on the control that acts on it — the link to /library, which reads `Show my 5 songs` off
	// `showAllCount` below — not in the sentence. Both halves stay pinned: the message must not claim there are
	// none, and the count must reach the surface.
	expect(s.showAllCount).toBe(5); // and offers the one tap back to the library
});

test('singular wording for a one-song library', () => {
	// This is the branch whose own MESSAGE names a count. The searching branch names none in its message — but it
	// hands `showAllCount` to a control that prints one, and that control owes the same agreement: `Show my 1 song`,
	// never `1 songs`. The noun lives at the call site because only the caller knows what it is counting.
	const s = noRowsState({ searchActive: false, libraryCount: 1 });
	expect(s.message).toContain('1 karaoke song ');
	expect(s.message).not.toContain('songs');
});

test('the control that PRINTS showAllCount agrees in number too', () => {
	/* THE DEFECT THIS CATCHES SHIPPED: the Sing tab's link to /library read `Show my {n} songs` flat, so a library
	 * holding one ready song — the ordinary state the first time a song finishes processing — said "Show my 1 songs"
	 * while /library's own count line two taps away said "1 song". It is asserted HERE, beside the function that
	 * hands the number over, because the agreement is a property of the pair and the label itself lives in markup no
	 * unit test instantiates. Comments are stripped first: the one above the control quotes the broken string. */
	const home = read('src/routes/(phone)/+page.svelte').replace(/<!--[\s\S]*?-->/g, '');
	expect(home).toMatch(/Show my \{empty\.showAllCount\}[\s\S]{0,90}=== 1 \? 'song' : 'songs'/);
});

test('a blank query while searchActive still reads sensibly (no empty quotes)', () => {
	const s = noRowsState({ searchActive: true, libraryCount: 3, query: '   ' });
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

/* THE RESTATED ARMS. This was ONE test, `'a settled or absent status leaves a plain waiting row'`, and it
   contradicted the invariant three lines above `queueCardKind` — so it is restated, arm by arm, rather than flipped.
   Its comment read "ready and canceled are terminal-and-settled: an ordinary turn, no process card", which silently
   equates THE PROCESS HAS STOPPED with THE TURN IS ORDINARY. Those two come apart exactly where the bug lives, and
   the `m()` fixture here is the shape it lives in: `stemStatus: 'none'` with no `instrumentalRef` — all 89 of the
   stranded entries in the owner's library copy.

   A CARD KIND IS A CLAIM ABOUT WHETHER THE ROTATION CAN EVER PLAY THE ENTRY, which is what both
   `nextPlayableEntryId` (client) and the server's `nextPlayable` act on. Read that way:
    · `{status:'ready'}`    — terminal AND the turn will play. "Ordinary" is TRUE, so this expect SURVIVES
                              unchanged, which is what shows the restatement is not a blanket flip.
    · `{status:'canceled'}` — terminal, and `cancel.ts` settles the media BACK to un-processed while the turn stays
                              in the rotation. "Ordinary" is FALSE: it can never play.
    · `undefined`           — not a claim about the turn at all; it is THIS PHONE'S IGNORANCE. And after a reload it
                              is the state of EVERY row: `mediaStatus` is in-memory only, and the cold-load seed
                              filters `readinessOf(m) === 'processing'`, so an unacquired media is in neither of
                              /api/library's lists. Rendering ignorance as "about to play" is the lie.

   PRECEDENT IN THIS FILE, which is why this is a restatement and not a new policy: the lyrics-upgrade test below
   already establishes that the CATALOG, not the event, decides. The arms are now discriminated BY THE MEDIA'S
   READINESS rather than by the liveness of the status, so the suite can no longer be satisfied by the "is it in
   flight" test the invariant condemns. */

test('a READY media is an ordinary waiting row, whatever the live status says', () => {
	const singable = m({
		stemStatus: 'ready',
		lyricsStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac'
	});
	expect(queueCardKind(singable, { status: 'ready' })).toBe('plain');
	expect(queueCardKind(singable, undefined)).toBe('plain');
	// The surviving expect from the test this replaces: a ready EVENT means the process landed before the catalog
	// caught up, so the turn will play even though this fixture's own catalog copy still says otherwise.
	expect(queueCardKind(m(), { status: 'ready' })).toBe('plain');
});

test('THE DEAD TURN: an unacquired media with no live status is STALLED, not a waiting row', () => {
	// The 89. No instrumental, nothing in flight to make one, and a queued entry pointing at it — which is a
	// precondition of calling this function at all, since its one call site is inside `{#each queued}`.
	expect(queueCardKind(m(), undefined)).toBe('stalled');
});

test('a canceled process on an unacquired media is STALLED: the job stopped, the turn did not', () => {
	/* `cancel.ts` settles the media back to un-processed and the entry stays in the rotation. Narrow but real:
	   `cancelJobsForMedia` only broadcasts `canceled` when no remaining entry references the media, so the
	   cancelling guest's own row is already gone — this arm is reached through a resync race, a `resendPending()`
	   add landing after another singer's remove cancelled the job. Pinned rather than deleted precisely because an
	   arm that narrow should be correct by construction instead of by a reachability argument. */
	expect(displayReadiness(m(), { status: 'canceled' })).toBe('unacquired'); // the premise
	expect(queueCardKind(m(), { status: 'canceled' })).toBe('stalled');
});

test('a media the CATALOG says is cooking keeps its progress card with no live status', () => {
	/* NEW COVERAGE, for the second defect the old `if (!live) return 'plain'` hid: a turn genuinely in flight drew
	   no bar at all whenever this phone held no live status for it. Reachable without a worker — `refreshLibrary()`
	   sets `libraryFailed` and returns while the catalog still arrives through `queue:sync`. */
	expect(queueCardKind(m({ stemStatus: 'queued' }), undefined)).toBe('processing');
});

test('UNSERVABLE is not progress: the server has said nobody can run this job', () => {
	/* NEW COVERAGE, for the third. `media:status` carries `unservable`, `#sweepUnservable` sets it only when the
	   stall blocks singing, and the TV's `processIsTerminal` has read it all along — the phone discarded it and so
	   drew "Making karaoke… 0%" with a live bar for the whole 120s TTL. It is NOT the failed card: no worker has
	   run anything, and one connecting is exactly what would clear the stall. */
	// Only the two fields the classifier reads: the wire event also carries `pct`/`etaSec`/`requestedBy`, and the
	// signature deliberately asks for no more than it consults.
	const cooking = m({ stemStatus: 'queued' });
	expect(queueCardKind(cooking, { status: 'queued' })).toBe('processing');
	expect(queueCardKind(cooking, { status: 'queued', unservable: true })).toBe('stalled');
});

test('a media missing from the catalog is still answered by the live status alone', () => {
	/* UNCHANGED, and kept because the rule is still right: a media absent from the catalog cannot be asked whether
	   it is singable, so there is nothing to read `unacquired` off and the event is the only witness. In practice
	   unreachable from /queue — `queue:sync` carries the media for every entry it sends. */
	expect(queueCardKind(undefined, undefined)).toBe('plain');
	expect(queueCardKind(undefined, { status: 'ready' })).toBe('plain');
	expect(queueCardKind(undefined, { status: 'canceled' })).toBe('plain');
	expect(queueCardKind(undefined, { status: 'separating' })).toBe('processing');
	expect(queueCardKind(undefined, { status: 'failed' })).toBe('failed');
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

// THE PROCESSING GROUP IS THE WIRE'S LIST AND NOTHING ELSE. The server already scoped `j.processing` to the
// query, so `processingGroupIds` takes that list alone.
//
// WHAT THESE TESTS USED TO PIN, and why the shape changed. The function also took the live status map, the whole
// catalog and a classifier, and unioned them whenever no search was active — which is how a song SOMEBODY ELSE was
// processing turned up under an unrelated query, the bug the search-scoped branch fixed. The union is RETIRED: the
// Sing tab's `processingRows` returns `[]` before calling this when no query is active, and /queue's processing
// group is derived from QUEUE ENTRIES, so no surface wanted the union and its three arguments could not be read.
// Query-scoping is therefore now a property of the SIGNATURE — there is no catalog in reach to re-scan — and the
// two tests that pinned the union are gone with it rather than left passing vacuously. What is still worth pinning
// is that this neither invents a row nor draws one job twice.

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: `ref-${id}`,
	title: id,
	durationSec: 200,
	stemStatus: 'queued', // in flight
	...over
});

// The trap, kept because it names the defect: both are genuinely processing, but only one matches the query, so
// `partitionSearch` put only that one on the wire. The other must not come back from anywhere.
const rickroll = media('rickroll', { title: 'Never Gonna Give You Up' });
const bsb = media('bsb', { title: 'I Want It That Way' });

test('THE BUG: the group is exactly what the server returned — no other processing song joins it', () => {
	expect([...processingGroupIds([rickroll])]).toEqual(['rickroll']);
	// And searching the other way round, so neither id is privileged by the fixture order.
	expect([...processingGroupIds([bsb])]).toEqual(['bsb']);
});

test('one media is one row, however many times the wire names it', () => {
	// The caller resolves each id against the catalog and renders a progress bar per row, so a duplicate would be
	// two bars for one job. Insertion order is preserved, which is the order the server ranked them in.
	expect([...processingGroupIds([rickroll, bsb, rickroll])]).toEqual(['rickroll', 'bsb']);
});

test('no processing results is an empty group, not a fallback to the catalog', () => {
	expect(processingGroupIds([]).size).toBe(0);
});

// ── the zero-state gate ──────────────────────────────────────────────────────────────────────────
//
// THE REPORTED BUG, as a predicate. Searching "i want it that way" returned twelve unprocessed songs
// which rendered correctly under "Needs karaoke" — and then the page ALSO printed
// `Nothing matches "i want it that way".` plus a `Show all 1` button beneath them. The inline gate was
// `!readyResults.length && library.length`, so it fired on nothing-READY rather than nothing-FOUND.

/* A FAILED SEARCH IS NOT AN EMPTY ONE, and this is the review's only blocks-the-party finding pinned.
   With the request dead the catch wipes the rows, so every count below is 0 and `searching` is already back to
   false — the exact shape of a genuine no-match. Without the `failed` term the screen then asserted
   `Nothing matches "<query>"` in the room's own voice, with a button pointing at somebody else's library, and it
   outlived the 4-second toast that was the only honest signal. Measured: still on screen at t+12s with the server
   healthy again, because only a fresh keystroke cleared it. */
test('a FAILED search does not render the no-rows state, however empty the groups are', () => {
	expect(showsNoRows({ searching: false, failed: true, readyCount: 0, rawCount: 0, processingCount: 0 })).toBe(false);
});

test('the failed term does not suppress a genuine no-match', () => {
	// The honest zero-state still has to work, or the fix trades one false claim for a blank screen.
	expect(showsNoRows({ searching: false, failed: false, readyCount: 0, rawCount: 0, processingCount: 0 })).toBe(true);
});

test('THE BUG: raw results on screen means the screen is NOT showing zero rows', () => {
	// Twelve "Needs karaoke" rows, nothing processed yet — the normal case for a fresh song.
	expect(showsNoRows({ searching: false, failed: false, readyCount: 0, rawCount: 12, processingCount: 0 })).toBe(false);
});

test('a group of any kind suppresses the zero-state', () => {
	expect(showsNoRows({ searching: false, failed: false, readyCount: 3, rawCount: 0, processingCount: 0 })).toBe(false);
	expect(showsNoRows({ searching: false, failed: false, readyCount: 0, rawCount: 0, processingCount: 1 })).toBe(false);
	expect(showsNoRows({ searching: false, failed: false, readyCount: 1, rawCount: 1, processingCount: 1 })).toBe(false);
});

test('only a finished search that found nothing at all may say so', () => {
	expect(showsNoRows({ searching: false, failed: false, readyCount: 0, rawCount: 0, processingCount: 0 })).toBe(true);
});

test('a search in flight never renders a zero-state, because the groups are the PREVIOUS query', () => {
	// Mid-flight the state still holds the last query's results (or nothing yet on a first search), so a
	// sentence here is a claim about a search that has not finished.
	expect(showsNoRows({ searching: true, failed: false, readyCount: 0, rawCount: 0, processingCount: 0 })).toBe(false);
	expect(showsNoRows({ searching: true, failed: false, readyCount: 0, rawCount: 5, processingCount: 0 })).toBe(false);
});
