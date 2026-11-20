import { expect, test } from 'bun:test';
import { youreUpTurn, youreUpMs } from '$lib/youre-up';
import type { QueueEntry } from '$lib/contract';

const entry = (id: string, singerId: string): QueueEntry => ({
	id,
	mediaId: `m-${id}`,
	singerId,
	status: 'playing',
	rotationSeq: 0,
	addedAt: 1
});
const entries = [entry('maya-1', 'maya'), entry('theo-1', 'theo')];
const base = { entries, meId: 'theo', positionSec: 0 };

test('the room moving on to MY song at its start is my turn', () => {
	expect(youreUpTurn({ ...base, previousId: 'maya-1', currentId: 'theo-1' })?.id).toBe('theo-1');
	// The night's first song, from an idle room.
	expect(youreUpTurn({ ...base, previousId: null, currentId: 'theo-1' })?.id).toBe('theo-1');
});

test('someone else’s song, no change, no room or no me: nothing to say', () => {
	expect(youreUpTurn({ ...base, previousId: 'theo-1', currentId: 'maya-1' })).toBeNull();
	expect(youreUpTurn({ ...base, previousId: 'theo-1', currentId: 'theo-1' })).toBeNull();
	expect(youreUpTurn({ ...base, previousId: 'theo-1', currentId: null })).toBeNull();
	expect(youreUpTurn({ ...base, meId: null, previousId: 'maya-1', currentId: 'theo-1' })).toBeNull();
});

test('a phone reloaded in the middle of its own song is not told it is up', () => {
	expect(youreUpTurn({ ...base, positionSec: 42, previousId: null, currentId: 'theo-1' })).toBeNull();
});

test('it holds as long as the TV card, and still shows when the card is off', () => {
	expect(youreUpMs({ songIntroEnabled: true, songIntroMs: 4000 })).toBe(4000);
	expect(youreUpMs({ songIntroEnabled: false, songIntroMs: 4000 })).toBe(2500);
});
