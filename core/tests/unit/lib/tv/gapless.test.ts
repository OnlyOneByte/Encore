// done-when (logic): the two-player swap is gapless when the hidden slot is pre-warmed.
import { test, expect } from 'bun:test';
import { GaplessController } from '$lib/tv/gapless';
import type { QueueEntry } from '$lib/contract';

const e = (id: string): QueueEntry => ({
	id,
	mediaId: 'm-' + id,
	singerId: 's1',
	status: 'queued',
	rotationSeq: 0,
	addedAt: 1
});

test('idle with no current -> attract', () => {
	const c = new GaplessController();
	c.onNowPlaying(null, null);
	expect(c.state).toBe('attract');
});

test('current loads into visible, upNext warms hidden', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), e('q2'));
	expect(c.state).toBe('loading');
	expect(c.assignment()).toMatchObject({ visible: 'A', hidden: 'B', visibleEntryId: 'q1', hiddenEntryId: 'q2' });
	c.onVisibleReady();
	expect(c.state).toBe('playing');
});

test('GAPLESS SWAP: hidden warmed for upNext -> ended swaps slots with no reload', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), e('q2'));
	c.onVisibleReady(); // q1 playing in A
	c.onHiddenReady('q2'); // B buffered q2
	expect(c.isNextReady('q2')).toBe(true);

	const visibleBefore = c.visible; // 'A'
	const next = c.onEnded(e('q2'));
	expect(next).toBe('interstitial'); // brief reveal, NOT loading (no network wait)
	expect(c.visible).not.toBe(visibleBefore); // swapped to B
	expect(c.currentId).toBe('q2');
	c.onInterstitialDone();
	expect(c.state).toBe('playing');
});

test('slot mapping: the warmed slot keeps upNext across the swap, before the server frame lands', () => {
	const c = new GaplessController();
	const [q1, q2] = [e('q1'), e('q2')];
	c.onNowPlaying(q1, q2);
	c.onVisibleReady();
	c.onHiddenReady('q2');
	expect(c.slotEntries(q1, q2)).toEqual({ visible: q1, hidden: q2 });
	c.onEnded(q2);
	// The page still holds the server's old pair here. Mapping it raw put q1 into the slot that had warmed q2.
	expect(c.slotEntries(q1, q2)).toEqual({ visible: q2, hidden: null });
	c.onNowPlaying(q2, null); // the server's frame: nothing moves
	expect(c.slotEntries(q2, null)).toEqual({ visible: q2, hidden: null });
});

test('MISSED WINDOW: hidden NOT warmed -> ended falls back to loading', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), e('q2'));
	c.onVisibleReady();
	// note: no onHiddenReady — B never finished buffering
	const next = c.onEnded(e('q2'));
	expect(next).toBe('loading'); // must buffer now
	expect(c.currentId).toBe('q2');
});

test('ended with no upNext -> attract', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), null);
	c.onVisibleReady();
	expect(c.onEnded(null)).toBe('attract');
	expect(c.currentId).toBeNull();
});

test('re-warm when upNext changes before swap (someone reordered)', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), e('q2'));
	c.onVisibleReady();
	c.onHiddenReady('q2');
	expect(c.state).toBe('playing');
	expect(c.isNextReady('q2')).toBe(true);
	// upNext changes to q3 (reorder) — hidden must re-warm, no longer ready for the new next.
	// current is UNCHANGED (q1): the same-current guard (gapless.ts) must NOT drop the visible
	// slot back to 'loading', or the full-screen interstitial card would mount over the playing
	// song. Every player command (pause/resume/seek/background/guide/key) re-emits
	// nowplaying:changed with an unchanged current, so this asserts the invariant, not the branch.
	c.onNowPlaying(e('q1'), e('q3'));
	expect(c.state).toBe('playing');
	expect(c.isNextReady('q3')).toBe(false);
	expect(c.assignment().hiddenEntryId).toBe('q3');
});

test('swap alternates slots A->B->A across two transitions', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), e('q2'));
	c.onHiddenReady('q2');
	c.onEnded(e('q2')); // A->B
	expect(c.visible).toBe('B');
	c.onInterstitialDone();
	c.onNowPlaying(e('q2'), e('q3'));
	c.onHiddenReady('q3');
	c.onEnded(e('q3')); // B->A
	expect(c.visible).toBe('A');
	expect(c.currentId).toBe('q3');
});

// The song intro used to be reachable ONLY through onEnded, i.e. only via a gapless swap between two
// songs. The first song of a session has nothing to swap from, so it was the one song that appeared
// unannounced — precisely the song where nobody yet knows whose turn it is.
test('enterInterstitial opens the intro from a state that is otherwise ready to play', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), null); // → loading
	c.onVisibleReady(); // the page opens the first intro once the song can play
	c.enterInterstitial();
	expect(c.state).toBe('interstitial');
	c.onInterstitialDone();
	expect(c.state).toBe('playing');
});

test('enterInterstitial refuses states where an intro would be a lie', () => {
	const c = new GaplessController();
	// attract: there is no song to introduce
	expect(c.state).toBe('attract');
	c.enterInterstitial();
	expect(c.state).toBe('attract');

	// waiting: the media is still processing, so announcing it as up would contradict the waiting screen
	c.onNowPlaying(e('q1'), null);
	c.enterWaiting();
	c.enterInterstitial();
	expect(c.state).toBe('waiting');
});

// UI-02: a skip puts the intro card up over a slot that is still LOADING the new song. The hold must not end in
// `playing` over an element with nothing in it.
test('an intro raised over a loading slot ends in loading, unless the slot got ready meanwhile', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), e('q2'));
	c.onVisibleReady();
	c.onNowPlaying(e('q2'), e('q3')); // a skip: the server moved on
	expect(c.state).toBe('loading');
	c.enterInterstitial();
	expect(c.state).toBe('interstitial');
	c.onInterstitialDone();
	expect(c.state).toBe('loading');
	c.onVisibleReady();
	expect(c.state).toBe('playing');

	c.onNowPlaying(e('q3'), null);
	c.enterInterstitial();
	c.onVisibleReady(); // buffered under the card
	expect(c.state).toBe('interstitial');
	c.onInterstitialDone();
	expect(c.state).toBe('playing');
});

// The page starts the card's exit fade before the hold ends only when the hold's end starts the song: over a slot
// still loading the card stays up past its hold, and fading it early would leave the stage empty under nothing.
test('introEndsInSong: true over a ready slot, false over a loading one until it is ready', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), e('q2'));
	c.onVisibleReady();
	expect(c.introEndsInSong).toBe(false); // playing, no intro
	c.onHiddenReady('q2');
	c.onEnded(e('q2')); // gapless swap: the warmed slot is buffered
	expect(c.introEndsInSong).toBe(true);
	c.onInterstitialDone();
	expect(c.introEndsInSong).toBe(false);

	c.onNowPlaying(e('q3'), null); // a skip: loading
	c.enterInterstitial();
	expect(c.introEndsInSong).toBe(false);
	c.onVisibleReady();
	expect(c.introEndsInSong).toBe(true);
});

test('STALE PAIR (#1001): a frame still naming the ended entry neither rewinds nor re-targets', () => {
	for (const warmed of [true, false]) {
		const c = new GaplessController();
		c.onNowPlaying(e('q1'), e('q2'));
		c.onVisibleReady();
		if (warmed) c.onHiddenReady('q2');
		c.onEnded(e('q2'));
		const before = c.assignment();
		// A phone command re-sends the server's old pair before it has processed `ended`; a reorder sends a new upNext.
		for (const stale of [e('q2'), e('q3')]) {
			expect(c.isBehind('q1')).toBe(true);
			c.onNowPlaying(e('q1'), stale);
			expect(c.assignment()).toEqual(before);
			expect(c.slotEntries(e('q1'), e('q2')).visible?.id).toBe('q2');
		}
		// Its playback state for q2, which lands BEFORE the pair, is the server catching up to what the TV plays.
		expect(c.isCatchingUp('q2')).toBe(true);
		expect(c.isCatchingUp('q1')).toBe(false);
		// The server's own frame moves past q1, and from there q1 is just an id again.
		c.onNowPlaying(e('q2'), e('q3'));
		expect(c.isBehind('q1')).toBe(false);
		expect(c.isCatchingUp('q2')).toBe(false); // a restart of q2 from here is a real restart
		expect(c.currentId).toBe('q2');
	}
});

test('STALE PAIR: an empty queue after the last song clears the guard too', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), null);
	c.onEnded(null);
	c.onNowPlaying(e('q1'), null); // stale
	expect(c.state).toBe('attract');
	c.onNowPlaying(null, null);
	expect(c.isBehind('q1')).toBe(false);
});

test('STALE PAIR: song 2 erroring inside the window keeps the guard on song 1', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), e('q2'));
	c.onVisibleReady();
	c.onEnded(e('q2')); // missed window: song 2 loads one frame early
	c.onEnded(e('q2')); // it will not play: its error ends it before the server's frame lands
	expect(c.isBehind('q1')).toBe(true);
	c.onNowPlaying(e('q1'), e('q2')); // a phone command's stale pair
	expect(c.currentId).toBe('q2');
});

test('STALE PAIR: the re-send repeats how the guarded entry ended, so a lost `failed` is never re-sent as `ended`', () => {
	// `ended` would mark the dead turn sung instead of keeping it queued, and the server would not hold the next song.
	const failed = new GaplessController();
	failed.onNowPlaying(e('q1'), e('q2'));
	failed.onEnded(e('q2'), 'failed');
	failed.onEnded(e('q3')); // song 2 ends too, before the server's frame: the guard and its status stay on song 1
	expect(failed.isBehind('q1')).toBe(true);
	expect(failed.endedStatus).toBe('failed');
	// The other way round: a sung song 1 stays `ended` when song 2 then fails inside the window.
	const sung = new GaplessController();
	sung.onNowPlaying(e('q1'), e('q2'));
	sung.onEnded(e('q2'));
	sung.onEnded(e('q3'), 'failed');
	expect(sung.endedStatus).toBe('ended');
	// The server's frame clears the guard, and the next end records its own status.
	sung.onNowPlaying(e('q3'), null);
	sung.onEnded(null, 'failed');
	expect(sung.isBehind('q3')).toBe(true);
	expect(sung.endedStatus).toBe('failed');
});

test('SKIP onto the warmed upNext (#1258): swaps to the buffered slot, as a natural end does', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), e('q2'));
	c.onVisibleReady();
	c.onHiddenReady('q2');
	c.onNowPlaying(e('q2'), e('q3')); // the server skipped q1
	expect(c.visible).toBe('B');
	expect(c.assignment()).toMatchObject({ visible: 'B', hidden: 'A', visibleEntryId: 'q2', hiddenEntryId: 'q3' });
	expect(c.slotEntries(e('q2'), e('q3'))).toEqual({ visible: e('q2'), hidden: e('q3') });
	expect(c.state).toBe('loading'); // until the buffered slot, now visible, reports ready
	c.onVisibleReady();
	expect(c.state).toBe('playing');
});

test('SKIP onto a song that is not warmed yet keeps the visible slot and loads it there', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), e('q2'));
	c.onVisibleReady();
	c.onNowPlaying(e('q2'), e('q3'));
	expect(c.visible).toBe('A');
	expect(c.state).toBe('loading');
	// Skipped past the warmed song altogether: no swap either.
	const d = new GaplessController();
	d.onNowPlaying(e('q1'), e('q2'));
	d.onHiddenReady('q2');
	d.onNowPlaying(e('q3'), null);
	expect(d.visible).toBe('A');
});

test('a warmed file that errored marks that song dead, until the slot warms something else', () => {
	const c = new GaplessController();
	c.onNowPlaying(e('q1'), e('q2'));
	c.onHiddenFailed('q9'); // not what the slot is warming: ignored
	c.onHiddenReady('q2');
	c.onHiddenFailed('q2');
	expect(c.isNextReady('q2')).toBe(false);
	c.onNowPlaying(e('q2'), e('q3'));
	expect(c.currentIsDead).toBe(true);
	expect(c.visible).toBe('A'); // a dead file is never swapped in
	// q3 warms next: a fresh target is not dead, and neither is a re-warm of the same entry later.
	c.onEnded(e('q3'), 'failed');
	c.onNowPlaying(e('q3'), e('q2'));
	expect(c.currentIsDead).toBe(false);
	c.onNowPlaying(e('q2'), null);
	expect(c.currentIsDead).toBe(false);
});
