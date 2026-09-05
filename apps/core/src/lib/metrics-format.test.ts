// guard: the operator metrics formatters, and specifically the unit-carry bug in `dur`.
//
// THE BUG THIS EXISTS FOR. `dur` rounded AFTER splitting the value into units, so a duration that
// rounded up into the next unit was printed as if it had not: 119_600ms rendered "1m 60s" and
// 59_960ms rendered "60.0s". Neither is a time. It survived because both metrics pages had their own
// copy of the function and neither had a test -- the extraction into one module is what made a test
// worth writing, and these two cases are why it is worth keeping.
import { test, expect } from 'bun:test';
import { dur, stepLabel, stageLabel } from './metrics-format';

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
