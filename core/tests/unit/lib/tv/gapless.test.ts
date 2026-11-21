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
