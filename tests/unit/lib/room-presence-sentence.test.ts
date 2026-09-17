// Pins the scanned-guest confirmation, in words (XR-PH-14, Q1-B). This is the one screen a
// non-sighted guest who scanned cannot otherwise perceive, so the sentence is the acceptance — and it
// must NEVER re-present the code. Each assertion targets one branch of the builder.
import { test, expect } from 'bun:test';
import { roomPresenceSentence } from '$lib/phrasing/room-presence-sentence';

test('an empty room says the guest will be first — not "0 people"', () => {
	const s = roomPresenceSentence({ code: 'ABCD23', presentCount: 0, names: [] });
	expect(s).toBe("This room is empty right now — you'll be the first here.");
	// The code never appears (XR-PH-14: once transcription happened the code has no function).
	expect(s.includes('ABCD23')).toBe(false);
});

test('one, two and three present are named in a natural sentence', () => {
	expect(roomPresenceSentence({ code: 'X', presentCount: 1, names: ['Maya'] })).toBe('Maya is here.');
	expect(roomPresenceSentence({ code: 'X', presentCount: 2, names: ['Maya', 'Dana'] })).toBe('Maya and Dana are here.');
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

/*
 * ── THE AWAY BRANCH ──────────────────────────────────────────────────────────────────────────────
 *
 * `/api/room-preview` used to count live sockets while `assertNameFree` refuses anyone not yet `gone`,
 * so a guest read "This room is empty right now — you'll be the first here." and was then rejected with
 * `the name "Maya" is taken`, while /tv showed "Maya AWAY" on its roster. Both now read one membership,
 * which means away members ARE counted — and that makes "Maya is here." the overclaim in the other
 * direction. These pin the wording that is true either way.
 */
test('a room whose members are all away says so instead of claiming they are here', () => {
	expect(roomPresenceSentence({ code: 'X', presentCount: 1, names: ['Maya'], awayCount: 1 })).toBe(
		'Maya is in the room, away right now.'
	);
	expect(roomPresenceSentence({ code: 'X', presentCount: 2, names: ['Maya', 'Dana'], awayCount: 2 })).toBe(
		'Maya and Dana are in the room, away right now.'
	);
	expect(roomPresenceSentence({ code: 'X', presentCount: 4, names: [], awayCount: 4 })).toBe(
		'4 people in the room, all away right now.'
	);
	expect(roomPresenceSentence({ code: 'X', presentCount: 1, names: [], awayCount: 1 })).toBe(
		'1 person in the room, away right now.'
	);
	expect(roomPresenceSentence({ code: 'X', presentCount: 6, names: ['Maya', 'Dana'], awayCount: 6 })).toBe(
		'6 people in the room, all away right now, including Maya and Dana.'
	);
});

test('an all-away room is never described as empty — the defect this branch exists for', () => {
	const s = roomPresenceSentence({ code: 'X', presentCount: 1, names: ['Maya'], awayCount: 1 });
	expect(s).not.toContain('empty');
	expect(s).toContain('Maya');
});

test('one reachable member is enough for the ordinary wording, whoever else is away', () => {
	// Mixed needs no special case: somebody IS here, and the away members are the difference between
	// the count and the names, which the count already carries.
	expect(roomPresenceSentence({ code: 'X', presentCount: 3, names: ['Maya'], awayCount: 2 })).toBe(
		'3 people here, including Maya.'
	);
	expect(roomPresenceSentence({ code: 'X', presentCount: 2, names: ['Maya', 'Dana'], awayCount: 1 })).toBe(
		'Maya and Dana are here.'
	);
});

test('an absent awayCount reads as "everyone counted is reachable"', () => {
	// A preview from an older server, or a fixture written before the field existed, still makes a
	// sentence — and it is the sentence that shape has always produced.
	expect(roomPresenceSentence({ code: 'X', presentCount: 1, names: ['Maya'] })).toBe('Maya is here.');
	// Nor can a nonsense value invent people: awayCount is clamped to the count.
	expect(roomPresenceSentence({ code: 'X', presentCount: 1, names: ['Maya'], awayCount: 9 })).toBe(
		'Maya is in the room, away right now.'
	);
	expect(roomPresenceSentence({ code: 'X', presentCount: 1, names: ['Maya'], awayCount: -3 })).toBe('Maya is here.');
});

test('the code is never re-presented in any branch', () => {
	for (const preview of [
		{ code: 'ABCD23', presentCount: 0, names: [] },
		{ code: 'ABCD23', presentCount: 1, names: ['Maya'] },
		{ code: 'ABCD23', presentCount: 5, names: ['Maya', 'Dana'] },
		{ code: 'ABCD23', presentCount: 9, names: [] },
		{ code: 'ABCD23', presentCount: 1, names: ['Maya'], awayCount: 1 },
		{ code: 'ABCD23', presentCount: 7, names: [], awayCount: 7 }
	]) {
		expect(roomPresenceSentence(preview).includes('ABCD23')).toBe(false);
	}
});
