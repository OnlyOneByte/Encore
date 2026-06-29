// M5-C3 ★★ done-when (logic): the two-player swap is gapless when the hidden slot is pre-warmed.
import { test, expect } from 'bun:test';
import { GaplessController } from './gapless';
import type { QueueEntry } from '@encore/shared';

const e = (id: string): QueueEntry => ({ id, mediaId: 'm-' + id, singerId: 's1', status: 'queued', rotationSeq: 0, addedAt: 1 });

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
	c.onHiddenReady('q2');
	expect(c.isNextReady('q2')).toBe(true);
	// upNext changes to q3 (reorder) — hidden must re-warm, no longer ready for the new next
	c.onNowPlaying(e('q1'), e('q3'));
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
