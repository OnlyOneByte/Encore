// "Your night": each slide only when it is true, and nothing that compares you with anyone.
import { test, expect } from 'bun:test';
import { keyLine, nightStory, setlistDetail, type StoryTurn } from '$lib/night-story';

const t = (over: Partial<StoryTurn> = {}): StoryTurn => ({
	title: 'Mayday',
	startedAt: 1_000,
	end: 'finished',
	keyShift: 0,
	cheers: 0,
	...over
});

test('a night with no cheers has no loudest slide, and one song is not "your loudest"', () => {
	expect(nightStory([t(), t({ title: 'Fly Away' })]).map((s) => s.kind)).toEqual(['cover', 'setlist']);
	expect(nightStory([t({ cheers: 3 })])[1]).toEqual({
		kind: 'loudest',
		cheers: 3,
		title: 'Mayday',
		ofSeveral: false
	});
});

test('the loudest is the most cheered, the earlier on a tie; a failed turn is not a song sung', () => {
	const slides = nightStory([
		t({ title: 'A', cheers: 5, startedAt: 1 }),
		t({ title: 'B', cheers: 9 }),
		t({ title: 'C', cheers: 9 }),
		t({ end: 'failed' })
	]);
	expect(slides[0]).toEqual({ kind: 'cover', songs: 3 });
	expect(slides[1]).toMatchObject({ title: 'B', cheers: 9, ofSeveral: true });
	expect(nightStory([t({ end: 'failed' })])).toEqual([]);
});

test('"your key" only when more than half the songs were shifted, by the shift used most', () => {
	expect(keyLine([t({ keyShift: -2 }), t()])).toBeNull();
	expect(keyLine([t({ keyShift: -2 }), t({ keyShift: -2 }), t({ keyShift: 1 })])).toBe('You like it 2 keys down.');
	expect(keyLine([t({ keyShift: 1 }), t({ keyShift: -3 })])).toBe('You like it 1 key up.');
});

test('a setlist row says only what is true', () => {
	expect(setlistDetail({ cheers: 0, keyShift: 0 })).toBe('');
	expect(setlistDetail({ cheers: 1, keyShift: 0 })).toBe('1 cheer');
	expect(setlistDetail({ cheers: 37, keyShift: -2 })).toBe('37 cheers · key −2');
	expect(setlistDetail({ cheers: 0, keyShift: 3 })).toBe('key +3');
});
