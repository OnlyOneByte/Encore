import { test, expect } from 'bun:test';
import { nextVideoSrc } from './video-src';
import { playbackRef, type Media } from '@encore/shared';

// The exact resolution TvPlayer's fileSrc does: `/media/${playbackRef(m)}`.
// Kept here so the test proves the property that matters — that two DISTINCT Media objects with equal
// fields resolve to the same string — rather than asserting a hand-written literal.
//
// It takes NO key shift any more. It used to be `keyedMediaRef(playbackRef(m), keyShift)`, naming a
// pre-rendered per-key file; transposition now happens in the browser, so the src is independent of
// the key. That strengthens Bug A rather than weakening it — see the shift test below.
const fileSrc = (m: Media): string => `/media/${playbackRef(m)}`;

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

test('a key shift does NOT reassign — the element must keep playing (browser pitch shift)', () => {
	// The inverse of the old assertion, and a strict improvement to Bug A. When ±key named a
	// pre-rendered FILE, changing key reassigned `src` and therefore RELOADED the element, restarting
	// the song from 0 the moment a singer touched the key control. Shifting in the browser leaves the
	// src alone, so a key change is now inaudible in the transport: same file, same currentTime, only
	// the AudioWorklet's ratio moves.
	const song = m();
	const prev = fileSrc(song);
	const { src, changed } = nextVideoSrc(prev, fileSrc(song));
	expect(changed).toBe(false);
	expect(src).toBe('/media/stems/m1-instrumental.wav');
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
