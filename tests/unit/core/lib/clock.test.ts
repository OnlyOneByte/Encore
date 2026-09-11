import { expect, it } from 'bun:test';
import { formatClock, formatRemaining, progressFraction } from '$lib/clock';

it('formatClock formats m:ss with a padded seconds field', () => {
	expect(formatClock(0)).toBe('0:00');
	expect(formatClock(9)).toBe('0:09');
	expect(formatClock(84)).toBe('1:24');
	expect(formatClock(600)).toBe('10:00');
});

it('formatClock grows to h:mm:ss only past an hour', () => {
	expect(formatClock(3599)).toBe('59:59');
	expect(formatClock(3600)).toBe('1:00:00');
	expect(formatClock(3661)).toBe('1:01:01');
});

// Position is interpolated from a wall clock, so it can land just below zero or carry a fraction.
it('formatClock floors fractions and clamps below zero', () => {
	expect(formatClock(0.9)).toBe('0:00');
	expect(formatClock(84.7)).toBe('1:24');
	expect(formatClock(-3)).toBe('0:00');
	expect(formatClock(NaN)).toBe('0:00');
});

it('formatRemaining counts down from the duration', () => {
	expect(formatRemaining(0, 216)).toBe('−3:36');
	expect(formatRemaining(84, 216)).toBe('−2:12');
});

// Rounding UP is why the label does not sit at −0:00 through the final second.
it('formatRemaining rounds up and never goes negative past the end', () => {
	expect(formatRemaining(215.2, 216)).toBe('−0:01');
	expect(formatRemaining(216, 216)).toBe('−0:00');
	expect(formatRemaining(400, 216)).toBe('−0:00');
});

it('progressFraction maps elapsed onto 0..1', () => {
	expect(progressFraction(0, 200)).toBe(0);
	expect(progressFraction(50, 200)).toBe(0.25);
	expect(progressFraction(200, 200)).toBe(1);
});

it('progressFraction clamps rather than overshooting when position runs past the end', () => {
	expect(progressFraction(260, 200)).toBe(1);
	expect(progressFraction(-5, 200)).toBe(0);
});

// The reason this returns null: a bar pinned at 0 reads as a stalled song, so the caller hides the
// row entirely for media whose duration is unknown.
it('progressFraction returns null when the duration cannot be known', () => {
	expect(progressFraction(30, 0)).toBeNull();
	expect(progressFraction(30, -1)).toBeNull();
	expect(progressFraction(30, NaN)).toBeNull();
	expect(progressFraction(NaN, 200)).toBeNull();
});
