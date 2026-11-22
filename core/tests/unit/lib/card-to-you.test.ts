import { test, expect } from 'bun:test';
import { CARD_SCROLL_QUIET_MS, cardScrollTarget, firstTimeFor, guestIsDriving } from '$lib/card-to-you';

test('each entry is decided once, ever', () => {
	expect(firstTimeFor('e-once')).toBe(true);
	expect(firstTimeFor('e-once')).toBe(false);
	expect(firstTimeFor('e-other')).toBe(true);
});

// 320x568 as measured on the real layout: header bottom 70, dock top 475, the heads-up card at 514.
const at320 = { cardTop: 514, controlBottom: 627, headerBottom: 70, dockTop: 475, scrollY: 0, gap: 8 };

test('a card whose first control is under the dock scrolls to just below the header', () => {
	expect(cardScrollTarget(at320)).toBe(514 - 70 - 8);
});

test('the target is relative to where the page already is', () => {
	expect(cardScrollTarget({ ...at320, scrollY: 100, cardTop: 414 })).toBe(100 + 414 - 70 - 8);
});

test('a reachable card does not move the page', () => {
	expect(cardScrollTarget({ ...at320, controlBottom: 475 })).toBeNull();
	expect(cardScrollTarget({ ...at320, cardTop: 70, controlBottom: 200 })).toBeNull();
});

test('a card scrolled up under the header comes back down to it', () => {
	expect(cardScrollTarget({ ...at320, scrollY: 600, cardTop: 20, controlBottom: 130 })).toBe(600 + 20 - 70 - 8);
});

test('the target never goes above the top of the page', () => {
	expect(cardScrollTarget({ ...at320, cardTop: 60, controlBottom: 500 })).toBe(0);
});

test('input inside the quiet window means the guest is driving', () => {
	expect(guestIsDriving(null, 10_000)).toBe(false);
	expect(guestIsDriving(10_000 - 1_000, 10_000)).toBe(true);
	expect(guestIsDriving(10_000 - CARD_SCROLL_QUIET_MS, 10_000)).toBe(false);
	expect(CARD_SCROLL_QUIET_MS).toBe(3_000);
});
