// guard: the operator metrics formatters, and specifically the unit-carry bug in `dur`.
//
// THE BUG THIS EXISTS FOR. `dur` rounded AFTER splitting the value into units, so a duration that
// rounded up into the next unit was printed as if it had not: 119_600ms rendered "1m 60s" and
// 59_960ms rendered "60.0s". Neither is a time. It survived because both metrics pages had their own
// copy of the function and neither had a test -- the extraction into one module is what made a test
// worth writing, and these two cases are why it is worth keeping.
import { test, expect } from 'bun:test';
import { dur, stepLabel, stageLabel, localStamp } from './metrics-format';

test('a missing timing is not zero', () => {
	// "not recorded" and "took no time" are different facts and must not render the same.
	expect(dur(null)).toBe('—');
});

test('durations never carry into a unit they do not print', () => {
	// The two regressions, pinned by value.
	expect(dur(119_600)).toBe('2m 0s'); // was "1m 60s"
	expect(dur(59_960)).toBe('1m 0s'); // was "60.0s"

	// The boundary either side of each carry, so a future "simplification" that reintroduces the
	// off-by-one is caught rather than merely the exact two values above.
	expect(dur(59_940)).toBe('59.9s');
	expect(dur(60_000)).toBe('1m 0s');
	expect(dur(119_400)).toBe('1m 59s');
	expect(dur(120_000)).toBe('2m 0s');
});

test('each branch prints its own unit', () => {
	expect(dur(0)).toBe('0ms');
	expect(dur(999)).toBe('999ms');
	expect(dur(1000)).toBe('1.0s');
	expect(dur(9040)).toBe('9.0s');
	expect(dur(154_000)).toBe('2m 34s');
});

test('an unmapped job type or stage falls through to its raw name', () => {
	// The point of the fallthrough: a newly added job type shows something imperfect rather than
	// vanishing from the operator's view.
	expect(stepLabel('stems')).toBe('remove vocals');
	expect(stepLabel('brand-new-job')).toBe('brand-new-job');
	expect(stageLabel('separating')).toBe('removing vocals');
	expect(stageLabel('brand-new-stage')).toBe('brand-new-stage');
});

// THE BUG localStamp EXISTS FOR (#141). The audit log printed every instant as
// `new Date(ms).toISOString()...` — UTC, with the `Z` sliced off so nothing said so. West of
// Greenwich the time was wrong, and for a US evening party (this box's own zone is CDT, UTC−5)
// anything after 19:00 local rolled the printed DATE to the next day. The instant below is the
// issue's own measured case: a song sung at 21:47:03 local on Sat 5 Sep 2026 in America/Chicago.
const CHICAGO_EVENING = Date.parse('2026-09-06T02:47:03Z'); // == 21:47:03 CDT on 2026-09-05

test('localStamp renders an evening US instant on the correct LOCAL date, not the next day', () => {
	// The exact defect: the old UTC form printed "2026-09-06 02:47:03" for this instant, dating a
	// Saturday-evening run to Sunday. In the viewer's own zone the date stays on the 5th.
	expect(localStamp(CHICAGO_EVENING, 'America/Chicago')).toBe('2026-09-05 21:47:03');
	// And it is NOT the UTC rendering the old code produced.
	expect(localStamp(CHICAGO_EVENING, 'America/Chicago')).not.toBe('2026-09-06 02:47:03');
});

test('localStamp is a pure function of instant + zone (same instant, different viewers)', () => {
	// The same instant read from three zones — the offset moves both the time AND, when it crosses
	// midnight, the date. UTC is where the old code was silently pinned.
	expect(localStamp(CHICAGO_EVENING, 'UTC')).toBe('2026-09-06 02:47:03');
	expect(localStamp(CHICAGO_EVENING, 'America/Chicago')).toBe('2026-09-05 21:47:03');
	expect(localStamp(CHICAGO_EVENING, 'Australia/Sydney')).toBe('2026-09-06 12:47:03');
});

test('localStamp holds the YYYY-MM-DD HH:MM:SS shape with zero-padding and 24h midnight', () => {
	// 05:15:30 UTC is 00:15:30 in Chicago — the hour must read "00", not Intl's "24".
	expect(localStamp(Date.parse('2026-09-06T05:15:30Z'), 'America/Chicago')).toBe('2026-09-06 00:15:30');
	// A single-digit month/day/hour must stay zero-padded so the string sorts and aligns.
	expect(localStamp(Date.parse('2026-03-07T14:09:04Z'), 'UTC')).toBe('2026-03-07 14:09:04');
});
