// Pins the scanned-guest confirmation, in words (XR-PH-14, Q1-B). This is the one screen a
// non-sighted guest who scanned cannot otherwise perceive, so the sentence is the acceptance — and it
// must NEVER re-present the code. Each assertion targets one branch of the builder.
import { test, expect } from 'bun:test';
import { roomPresenceSentence } from './room-presence-sentence';

test('an empty room says the guest will be first — not "0 people"', () => {
	const s = roomPresenceSentence({ code: 'ABCD23', presentCount: 0, names: [] });
	expect(s).toBe("This room is empty right now — you'll be the first here.");
	// The code never appears (XR-PH-14: once transcription happened the code has no function).
	expect(s.includes('ABCD23')).toBe(false);
});

test('one, two and three present are named in a natural sentence', () => {
	expect(roomPresenceSentence({ code: 'X', presentCount: 1, names: ['Maya'] })).toBe('Maya is here.');
	expect(roomPresenceSentence({ code: 'X', presentCount: 2, names: ['Maya', 'Dana'] })).toBe(
		'Maya and Dana are here.'
	);
	expect(roomPresenceSentence({ code: 'X', presentCount: 3, names: ['Maya', 'Dana', 'Lee'] })).toBe(
		'Maya, Dana and Lee are here.'
	);
});

test('more people than names leads with the count, then names a few', () => {
	const s = roomPresenceSentence({ code: 'X', presentCount: 5, names: ['Maya', 'Dana'] });
	expect(s).toBe('5 people here, including Maya and Dana.');
});

test('a known count with no names states the count plainly', () => {
	expect(roomPresenceSentence({ code: 'X', presentCount: 6, names: [] })).toBe('6 people here.');
	expect(roomPresenceSentence({ code: 'X', presentCount: 1, names: [] })).toBe('1 person here.');
});

test('the code is never re-presented in any branch', () => {
	for (const preview of [
		{ code: 'ABCD23', presentCount: 0, names: [] },
		{ code: 'ABCD23', presentCount: 1, names: ['Maya'] },
		{ code: 'ABCD23', presentCount: 5, names: ['Maya', 'Dana'] },
		{ code: 'ABCD23', presentCount: 9, names: [] }
	]) {
		expect(roomPresenceSentence(preview).includes('ABCD23')).toBe(false);
	}
});
