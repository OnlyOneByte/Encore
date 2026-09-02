// playbackRef: "what should the player load?" — kept separate from Media.sourceRef so sourceRef can
// stay the song's immutable ORIGIN identity. Overwriting sourceRef with the stem key (the old
// behaviour) forked a cooked song into two catalog rows, because search dedupes on origin.
import { test, expect } from 'bun:test';
import { playbackRef, keyedMediaRef, type Media } from './index';

const m = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'djV11Xbc914',
	title: 'Take On Me',
	durationSec: 225,
	stemStatus: 'none',
	playMode: 'iframe',
	...over
});

test('an iframe song plays its origin (the youtube id), instrumental or not', () => {
	expect(playbackRef(m())).toBe('djV11Xbc914');
	// even if a stems job left an instrumental behind, an iframe song embeds the origin
	expect(playbackRef(m({ instrumentalRef: 'stems/m1-instrumental.wav' }))).toBe('djV11Xbc914');
});

test('a cooked file song plays its instrumental, NOT its origin', () => {
	const cooked = m({ playMode: 'file', stemStatus: 'ready', instrumentalRef: 'stems/m1-instrumental.wav' });
	expect(playbackRef(cooked)).toBe('stems/m1-instrumental.wav');
	expect(cooked.sourceRef).toBe('djV11Xbc914'); // origin still intact for search dedupe
});

test('a plain local file (no stems) plays its own file key', () => {
	const local = m({ source: 'local', sourceRef: 'library/sweet-caroline.mp4', playMode: 'file' });
	expect(playbackRef(local)).toBe('library/sweet-caroline.mp4');
});

test('a file song still cooking falls back to its origin rather than a missing stem key', () => {
	// mid-cook the media is already playMode:file but has no instrumentalRef yet. Rotation holds the
	// entry so this ref is not played, but it must not resolve to undefined.
	const cooking = m({ source: 'local', sourceRef: 'library/x.mp4', playMode: 'file', stemStatus: 'queued' });
	expect(playbackRef(cooking)).toBe('library/x.mp4');
});

test('composes with keyedMediaRef: the ±key variant is derived from the INSTRUMENTAL', () => {
	const cooked = m({ playMode: 'file', stemStatus: 'ready', instrumentalRef: 'stems/m1-instrumental.wav' });
	expect(keyedMediaRef(playbackRef(cooked), 2)).toBe('stems/m1-instrumental.+2.wav');
	expect(keyedMediaRef(playbackRef(cooked), 0)).toBe('stems/m1-instrumental.wav');
});
