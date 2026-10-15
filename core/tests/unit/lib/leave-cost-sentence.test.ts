// The leave confirm's one sentence, branch by branch. The sentence IS the price statement for the only guest action
// with no undo, so each expectation below is a HARD-CODED string — never built by calling the thing under test, which
// is how a wrong plural or a null-as-zero passes its own test.
//
// The branch that exists because of a defect is `null`. The confirm used to read `leaveCost?.queuedCount ?? 0` and so
// asserted "You have no songs queued" to a guest with three queued, for as long as the cost fetch took — permanently
// if it failed — and announced exactly that at mount to a screen reader, which never hears the correction.
import { test, expect } from 'bun:test';
import { leaveCostSentence } from '$lib/phrasing/leave-cost-sentence';

test('an UNKNOWN cost names no number, and never claims zero', () => {
	const s = leaveCostSentence(null);
	expect(s).toBe("Any songs you have queued will be removed, and you'll need to rejoin to sing again.");
	// The three ways the old sentence was wrong about an unanswered fetch.
	expect(s).not.toContain('no songs queued');
	expect(s).not.toMatch(/\d/);
	// And it stays silent about the TV, because it has not been told whether anything is playing.
	expect(s).not.toContain('on screen');
});

test('a KNOWN zero is still allowed to say so — it is a measured fact, not a default', () => {
	expect(leaveCostSentence({ queuedCount: 0, hasPlaying: false })).toBe(
		"You have no songs queued, and you'll need to rejoin to sing again."
	);
});

test('one and many are counted, with the singular spelled out rather than "1 songs"', () => {
	expect(leaveCostSentence({ queuedCount: 1, hasPlaying: false })).toBe(
		"Your 1 queued song will be removed, and you'll need to rejoin to sing again."
	);
	expect(leaveCostSentence({ queuedCount: 3, hasPlaying: false })).toBe(
		"Your 3 queued songs will be removed, and you'll need to rejoin to sing again."
	);
});

test('a song of yours on screen gets its own clause, appended to any known count', () => {
	// `queuedCount` EXCLUDES the playing entry (removableOnLeave does), so 0-plus-playing is a real combination and
	// the two facts have to be able to disagree.
	expect(leaveCostSentence({ queuedCount: 0, hasPlaying: true })).toBe(
		"You have no songs queued, and you'll need to rejoin to sing again. The song on screen now will finish."
	);
	expect(leaveCostSentence({ queuedCount: 2, hasPlaying: true })).toBe(
		"Your 2 queued songs will be removed, and you'll need to rejoin to sing again. The song on screen now will finish."
	);
});
