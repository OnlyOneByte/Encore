// guideOffsetSec: the pure absent-safe conversion of the measured guide/instrumental offset from
// stored milliseconds to the seconds the client aligns in. The whole point of this helper is the DEFAULT:
// a song with no measured offset (the entire existing library on the day this lands) must resolve to 0, so
// the client holds the guide exactly as today. Keeping the default here — not at each TvPlayer call site —
// is what lets guide-sync.ts receive `masterSec + guideOffsetSec` without ever branching on presence.
import { test, expect } from 'bun:test';
import { guideOffsetSec, type Media } from '@encore/shared';

const m = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'abc',
	title: 'Take On Me',
	durationSec: 225,
	stemStatus: 'ready',
	...over
});

test('absent offset is 0 — today\u2019s behaviour for the whole existing library', () => {
	expect(guideOffsetSec(m())).toBe(0);
	expect(guideOffsetSec(m({ guideOffsetMs: undefined }))).toBe(0);
});

test('a stored millisecond offset converts to seconds', () => {
	expect(guideOffsetSec(m({ guideOffsetMs: 30 }))).toBeCloseTo(0.03, 6);
	expect(guideOffsetSec(m({ guideOffsetMs: 1000 }))).toBe(1);
});

test('a negative offset (vocals lead) keeps its sign', () => {
	expect(guideOffsetSec(m({ guideOffsetMs: -25 }))).toBeCloseTo(-0.025, 6);
});

test('a measured 0 is 0 — indistinguishable from absent to the client, on purpose', () => {
	expect(guideOffsetSec(m({ guideOffsetMs: 0 }))).toBe(0);
});

test('a non-finite stored value degrades to 0, never NaN into currentTime', () => {
	// A NaN or Infinity reaching an element's currentTime throws; the helper is the boundary that stops
	// a corrupt stored value from ever getting there.
	expect(guideOffsetSec(m({ guideOffsetMs: NaN }))).toBe(0);
	expect(guideOffsetSec(m({ guideOffsetMs: Infinity }))).toBe(0);
});
