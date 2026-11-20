import { expect, test } from 'bun:test';
import { NO_TARGET, SETTLE_MS, observeShown, transportTarget } from '$lib/transport-target';

// 974-M2: two real taps 40-80 ms apart took two songs, because the second phone had already redrawn to the next song.

test('a tap just after the strip moved on names the song that was there, so the server drops it', () => {
	let t = observeShown(NO_TARGET, 'maya', 0);
	t = observeShown(t, 'theo', 10_000); // Ana's skip landed; this phone redrew 30 ms later
	expect(transportTarget(t, 10_040)).toBe('maya');
	expect(transportTarget(t, 10_000 + SETTLE_MS - 1)).toBe('maya');
});

test('once the settle window has passed, the tap names the song on the strip', () => {
	let t = observeShown(NO_TARGET, 'maya', 0);
	t = observeShown(t, 'theo', 10_000);
	expect(transportTarget(t, 10_000 + SETTLE_MS)).toBe('theo');
});

test('a song that started from an idle room, or the first song this phone saw, names itself at once', () => {
	expect(transportTarget(observeShown(NO_TARGET, 'maya', 5_000), 5_010)).toBe('maya');
	let t = observeShown(NO_TARGET, 'maya', 0);
	t = observeShown(t, null, 1_000); // the room went idle
	t = observeShown(t, 'theo', 9_000);
	expect(transportTarget(t, 9_010)).toBe('theo');
});

test('re-observing the same song does not restart the window', () => {
	let t = observeShown(NO_TARGET, 'maya', 0);
	t = observeShown(t, 'theo', 10_000);
	const same = observeShown(t, 'theo', 10_900);
	expect(same).toBe(t);
	expect(transportTarget(same, 11_000)).toBe('theo');
});
