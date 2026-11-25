import { expect, test } from 'bun:test';
import { youreUpTurn, youreUpMs, floodColors } from '$lib/youre-up';
import type { QueueEntry } from '$lib/contract';
import { contrastRatio } from '$lib/contract/presentation/colors';
import { PALETTE_STOPS } from '$lib/contract/presentation/player-palette';

test('the flood reads on every one of the 48 singer colours: text at 4.5:1, the focus ring at 3:1', () => {
	const worst: { name: string; ratio: number }[] = [];
	for (const stop of PALETTE_STOPS) {
		const { bg, ink } = floodColors(stop.fill);
		const ratio = contrastRatio(bg, ink);
		// The ink is the text and the focus ring, so the text floor covers both.
		expect(ratio, `${stop.name}: ink ${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
		expect(ratio, `${stop.name}: focus ring`).toBeGreaterThanOrEqual(3);
		worst.push({ name: stop.name, ratio });
	}
	expect(worst).toHaveLength(48);
});

test('the flood is darker than the singer colour, in the same hue family', () => {
	const stop = PALETTE_STOPS[0]!;
	const { bg } = floodColors(stop.fill);
	expect(bg).not.toBe(stop.fill);
	// Darker: against black, the flood has less contrast than the fill.
	expect(contrastRatio(bg, '#000000')).toBeLessThan(contrastRatio(stop.fill, '#000000'));
	// A colour off the ring snaps to its nearest stop first, so two shades of one stop flood alike.
	expect(floodColors('#ff7363')).toEqual(floodColors(stop.fill));
});

const entry = (id: string, singerId: string): QueueEntry => ({
	id,
	mediaId: `m-${id}`,
	singerId,
	status: 'playing',
	rotationSeq: 0,
	addedAt: 1
});
const entries = [entry('maya-1', 'maya'), entry('theo-1', 'theo')];
const base = { entries, meId: 'theo', positionSec: 0, isPlaying: true };

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

test('a turn held behind the TV’s Skipped notice is announced when it starts playing, with the TV card', () => {
	// The failed song's advance lands paused: nothing yet.
	expect(youreUpTurn({ ...base, isPlaying: false, previousId: 'maya-1', currentId: 'theo-1' })).toBeNull();
	// The notice clears and the room plays from 0: now. The layout keeps `previousId` on the last PLAYING turn.
	expect(youreUpTurn({ ...base, previousId: 'maya-1', currentId: 'theo-1' })?.id).toBe('theo-1');
});

test('it holds as long as the TV card, and still shows when the card is off', () => {
	expect(youreUpMs({ songIntroEnabled: true, songIntroMs: 4000 })).toBe(4000);
	expect(youreUpMs({ songIntroEnabled: false, songIntroMs: 4000 })).toBe(2500);
});
