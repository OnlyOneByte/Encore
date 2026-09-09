// XR-PH-09 — the guest's position is stated in WORDS, and the wait degrades HONESTLY when it cannot
// be known. Issue #832.
//
// The requirement's acceptance is two-armed and the second arm is the one that ships bugs: "Given any
// entry ahead lacks a duration, Then no minutes clause renders and the string never contains
// 'roughly 0'". So every expectation below is a HARD-CODED string or an independently hand-computed
// minute count — never `Math.round(total / 60)`, which is the operation under test. That is the #165
// failure exactly: a test that rounds its own expected value cannot detect whether the code rounds.
import { test, expect } from 'bun:test';
import { positionWords, waitWords, ordinalWord } from './position-sentence';

test('ordinalWord handles the teens, which is the whole reason it is a function', () => {
	// Hand-written table. A naive n % 10 implementation ships "11st"/"12nd"/"13rd" and reds here.
	expect(ordinalWord(1)).toBe('1st');
	expect(ordinalWord(2)).toBe('2nd');
	expect(ordinalWord(3)).toBe('3rd');
	expect(ordinalWord(4)).toBe('4th');
	expect(ordinalWord(11)).toBe('11th');
	expect(ordinalWord(12)).toBe('12th');
	expect(ordinalWord(13)).toBe('13th');
	expect(ordinalWord(21)).toBe('21st');
	expect(ordinalWord(22)).toBe('22nd');
	expect(ordinalWord(23)).toBe('23rd');
	expect(ordinalWord(101)).toBe('101st');
	expect(ordinalWord(111)).toBe('111th');
});

test('the direction promise renders verbatim when every duration ahead is known', () => {
	// 2:00 left of the playing song + 3:20 + 5:41 ahead = 661s. 661/60 = 11.0166…, which rounds to 11.
	// The 11 is written out here, not computed, so a builder that floored (10) or truncated the float
	// ("11.016666666666666") reds.
	const w = positionWords({
		place: 3,
		beforeName: 'Sam',
		nowRemainingSec: 120,
		aheadDurationsSec: [200, 341]
	});
	expect(w).not.toBeNull();
	expect(w!.ordinal).toBe('3rd');
	expect(w!.lead).toBe("You're up after Sam.");
	expect(w!.wait).toBe('Roughly 11 minutes.');
});

test('an entry ahead with no resolvable length omits the minutes clause entirely (XR-PH-09)', () => {
	// `Media.durationSec` is REQUIRED, so the reachable unknown is an entry whose media is absent from
	// the catalog — the caller maps that to null. One null makes the sum unknown.
	const w = positionWords({
		place: 3,
		beforeName: 'Sam',
		nowRemainingSec: 120,
		aheadDurationsSec: [200, null]
	});
	expect(w!.wait).toBeNull();
	// The ordinal and the "after whom" half MUST survive the degradation — that is what makes it
	// honest rather than merely absent.
	expect(w!.ordinal).toBe('3rd');
	expect(w!.lead).toBe("You're up after Sam.");
});

test('a playing song of unknown length makes the whole wait unknown', () => {
	const w = positionWords({ place: 2, beforeName: 'Maya', nowRemainingSec: null, aheadDurationsSec: [200] });
	expect(w!.wait).toBeNull();
});

test('a partial sum is never reported as the wait', () => {
	// The failure this pins: skipping the unknown term and summing the rest, which UNDERSTATES the
	// wait — a guest told "roughly 3 minutes" who then waits twenty is the witnessed-wrong-claim case.
	const known = waitWords(0, [180]);
	const withUnknown = waitWords(0, [180, null]);
	expect(known).toBe('Roughly 3 minutes.');
	expect(withUnknown).toBeNull();
	expect(withUnknown).not.toBe(known);
});

test('a sub-minute wait is a phrase, so "roughly 0 minutes" cannot render', () => {
	expect(waitWords(20, [])).toBe('Less than a minute.');
	expect(waitWords(0, [])).toBe('Less than a minute.');
	expect(waitWords(44, [])).toBe('Less than a minute.');
	// 45s is the first wait stated as a number, and it states ONE, not zero.
	expect(waitWords(45, [])).toBe('Roughly 1 minute.');
	expect(waitWords(60, [])).toBe('Roughly 1 minute.'); // singular, not "1 minutes"
	expect(waitWords(120, [])).toBe('Roughly 2 minutes.');
});

test('no reachable wait ever renders a zero or a NaN', () => {
	// Sweep every second of a plausible party wait plus the degenerate inputs. This is a property, so
	// it is asserted as one rather than as another rounded expectation.
	for (let sec = 0; sec <= 3600; sec += 1) {
		const s = waitWords(sec, []);
		expect(s).not.toBeNull();
		expect(s!.toLowerCase()).not.toContain('roughly 0');
		expect(s!).not.toContain('NaN');
		expect(s!).not.toContain('undefined');
	}
	expect(waitWords(Number.NaN, [])).toBeNull();
	expect(waitWords(0, [Number.NaN])).toBeNull();
});

test('place 1 says "up next" only when the pick can actually play', () => {
	expect(positionWords({ place: 1, nowRemainingSec: 30 })!.lead).toBe("You're up next.");
	expect(positionWords({ place: 1, nowRemainingSec: 30, playable: false })!.lead).toBe(
		"You're next once it's ready."
	);
});

test('an unresolved singer name degrades to a true sentence, not to "undefined"', () => {
	const w = positionWords({ place: 4, beforeName: null, nowRemainingSec: 0, aheadDurationsSec: [60, 60, 60] });
	expect(w!.lead).toBe("You're up after the song ahead of you.");
	expect(w!.lead).not.toContain('undefined');
	expect(w!.lead).not.toContain('null');
});

test('nothing queued renders no card at all', () => {
	expect(positionWords({ place: 0 })).toBeNull();
	expect(positionWords({ place: -1 })).toBeNull();
	expect(positionWords({ place: Number.NaN })).toBeNull();
});
