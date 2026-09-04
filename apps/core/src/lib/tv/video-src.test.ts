import { test, expect } from 'bun:test';
import { nextVideoSrc } from './video-src';
import { keyedMediaRef, playbackRef, type Media } from '@encore/shared';

// The exact resolution TvPlayer's fileSrc does: `/media/${keyedMediaRef(playbackRef(m), keyShift)}`.
// Kept here so the test proves the property that matters — that two DISTINCT Media objects with equal
// fields resolve to the same string — rather than asserting a hand-written literal.
const fileSrc = (m: Media, keyShift = 0): string => `/media/${keyedMediaRef(playbackRef(m), keyShift)}`;

const m = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'djV11Xbc914',
	title: 'Take On Me',
	durationSec: 225,
	stemStatus: 'ready',
	instrumentalRef: 'stems/m1-instrumental.wav',
	...over
});

test('two distinct Media objects with identical fields do NOT reassign (Bug A)', () => {
	// This is the exact shape of the bug: queue:sync rebuilt the catalog, handing syncSlots a fresh
	// object identity for the playing song. The resolved src is byte-identical, so the element must
	// not be written — assigning it would reload and reset currentTime to 0.
	const a = m();
	const b = m(); // a separate object, same values
	expect(a).not.toBe(b); // genuinely distinct identities
	const prev = fileSrc(a);
	const { changed } = nextVideoSrc(prev, fileSrc(b));
	expect(changed).toBe(false);
});

test('a real instrumental change DOES reassign', () => {
	const prev = fileSrc(m());
	const upgraded = m({ instrumentalRef: 'stems/m1-instrumental.roformer.wav' });
	const { src, changed } = nextVideoSrc(prev, fileSrc(upgraded));
	expect(changed).toBe(true);
	expect(src).toBe('/media/stems/m1-instrumental.roformer.wav');
});

test('a real key-shift change DOES reassign (the keyed variant is a different file)', () => {
	const song = m();
	const prev = fileSrc(song, 0);
	const { src, changed } = nextVideoSrc(prev, fileSrc(song, 2));
	expect(changed).toBe(true);
	expect(src).toBe('/media/stems/m1-instrumental.+2.wav');
});

test('the first assignment (no previous src) always changes', () => {
	const { src, changed } = nextVideoSrc(null, fileSrc(m()));
	expect(changed).toBe(true);
	expect(src).toBe('/media/stems/m1-instrumental.wav');
});

test('resolving to empty (nothing playable) from a real src changes; empty-to-empty does not', () => {
	expect(nextVideoSrc('/media/stems/m1-instrumental.wav', '').changed).toBe(true);
	expect(nextVideoSrc('', '').changed).toBe(false);
});
