// The guiding-track level: clamping, the null-means-inherit contract, and availability.
//
// The load-bearing distinction throughout is `null` (no per-song override — use the room default)
// versus `0` (explicitly off for this song). Collapsing the two is the bug this shape exists to
// prevent: it would make a room default impossible to honour after the first song change.
import { describe, it, expect } from 'bun:test';
import {
	clampGuideLevel,
	effectiveGuideLevel,
	hasGuidingTrack,
	normalizeRoomSettings,
	DEFAULT_ROOM_SETTINGS,
	type Media
} from '../index';

const processed = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'x',
	title: 'song',
	durationSec: 100,
	stemStatus: 'ready',
	instrumentalRef: 'derived/stems/m1-instrumental.flac',
	...over
});

describe('clampGuideLevel', () => {
	it('passes a valid level through, rounded to whole percent', () => {
		expect(clampGuideLevel(0)).toBe(0);
		expect(clampGuideLevel(0.15)).toBe(0.15);
		expect(clampGuideLevel(1)).toBe(1);
		expect(clampGuideLevel(0.12345)).toBe(0.12);
	});

	it('clamps out-of-range values rather than rejecting them', () => {
		expect(clampGuideLevel(5)).toBe(1);
		expect(clampGuideLevel(-1)).toBe(0);
	});

	it('treats null/undefined as CLEAR (inherit), not as 0', () => {
		expect(clampGuideLevel(null)).toBeNull();
		expect(clampGuideLevel(undefined)).toBeNull();
	});

	it('refuses to invent a level from garbage — non-finite clears rather than flooring to 0', () => {
		// 0 would be a fabricated instruction ("this song is explicitly off"); null is honest.
		expect(clampGuideLevel(NaN)).toBeNull();
		expect(clampGuideLevel(Infinity)).toBeNull();
		expect(clampGuideLevel(-Infinity)).toBeNull();
	});
});

describe('effectiveGuideLevel', () => {
	it('uses the per-song override when one is pinned', () => {
		expect(effectiveGuideLevel({ guideLevel: 0.4 }, 0.1)).toBe(0.4);
	});

	it('falls back to the room default when the override is cleared', () => {
		expect(effectiveGuideLevel({ guideLevel: null }, 0.2)).toBe(0.2);
	});

	it('honours an explicit 0 override INSTEAD of the room default', () => {
		// the whole reason guideLevel is nullable: a singer turning the guide off for one song must
		// not be overridden by the room's standing preference
		expect(effectiveGuideLevel({ guideLevel: 0 }, 0.5)).toBe(0);
	});

	it('always returns a number the player can assign to .volume', () => {
		expect(effectiveGuideLevel({ guideLevel: null }, NaN)).toBe(0);
		expect(effectiveGuideLevel({ guideLevel: null }, 9)).toBe(1);
	});
});

describe('hasGuidingTrack', () => {
	it('is true only for a playable song that also has a vocals stem', () => {
		expect(hasGuidingTrack(processed({ vocalsRef: 'derived/stems/m1-vocals.m4a' }))).toBe(true);
	});

	it('is false without a vocals stem (processed before the ref existed, or a silent stem)', () => {
		expect(hasGuidingTrack(processed())).toBe(false);
	});

	it('is false for an unprocessed song even if a vocals ref is somehow present', () => {
		// there is nothing to mix the vocals UNDER until the instrumental exists
		expect(
			hasGuidingTrack({
				stemStatus: 'none',
				instrumentalRef: undefined,
				vocalsRef: 'derived/stems/m1-vocals.m4a'
			})
		).toBe(false);
	});
});

describe('normalizeRoomSettings guideLevelDefault', () => {
	it('ships at 0 — the feature is opt-in and reproduces pure karaoke', () => {
		expect(DEFAULT_ROOM_SETTINGS.guideLevelDefault).toBe(0);
	});

	it('accepts and rounds a valid default', () => {
		expect(normalizeRoomSettings({ guideLevelDefault: 0.15 }).guideLevelDefault).toBe(0.15);
		expect(normalizeRoomSettings({ guideLevelDefault: 0.129 }).guideLevelDefault).toBe(0.13);
	});

	it('clamps rather than rejecting, so a bad value still yields a usable room', () => {
		expect(normalizeRoomSettings({ guideLevelDefault: 4 }).guideLevelDefault).toBe(1);
		expect(normalizeRoomSettings({ guideLevelDefault: -2 }).guideLevelDefault).toBe(0);
	});

	it('keeps the room CURRENT value on a junk write, not the hardcoded default', () => {
		const base = { ...DEFAULT_ROOM_SETTINGS, guideLevelDefault: 0.3 };
		expect(normalizeRoomSettings({ guideLevelDefault: NaN }, base).guideLevelDefault).toBe(0.3);
		expect(normalizeRoomSettings({ guideLevelDefault: 'loud' as unknown as number }, base).guideLevelDefault).toBe(0.3);
	});

	it('an omitted field is a patch, not a reset', () => {
		const base = { ...DEFAULT_ROOM_SETTINGS, guideLevelDefault: 0.25 };
		expect(normalizeRoomSettings({ songIntroMs: 1000 }, base).guideLevelDefault).toBe(0.25);
	});
});
