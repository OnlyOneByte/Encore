// playbackRef: "what should the player load?" — kept separate from Media.sourceRef so sourceRef can
// stay the song's immutable ORIGIN identity. Overwriting sourceRef with the stem key (the old
// behaviour) forked a cooked song into two catalog rows, because search dedupes on origin.
//
// Nothing plays unprocessed: the only thing the player ever loads is a separated instrumental. There
// is no embed path and no raw-source path, so "what to play" and "is there anything to play" are the
// same question — which is why isPlayable is defined in terms of playbackRef rather than beside it.
import { test, expect } from 'bun:test';
import { playbackRef, isPlayable, type Media } from '$lib/contract';

const m = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'djV11Xbc914',
	title: 'Take On Me',
	durationSec: 225,
	stemStatus: 'none',
	...over
});

test('a cooked song plays its instrumental, NOT its origin', () => {
	const cooked = m({ stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'stems/m1-instrumental.wav' });
	expect(playbackRef(cooked)).toBe('stems/m1-instrumental.wav');
	expect(isPlayable(cooked)).toBe(true);
	expect(cooked.sourceRef).toBe('djV11Xbc914'); // origin still intact for search dedupe
});

test('an unseparated song has NOTHING to play — the origin is never a playback ref', () => {
	// This is the whole point of removing the embed path: a YouTube id is an identity, not something
	// the player can load. Returning sourceRef here is what used to let the room sing over the
	// original vocals.
	expect(playbackRef(m())).toBe('');
	expect(isPlayable(m())).toBe(false);
});

test('a local file is no more playable than a YouTube one until it is separated', () => {
	// A local library file used to play directly, vocals and all. It is now a cook candidate like any
	// other source — one rule for playability, no per-source branch.
	const local = m({ source: 'local', sourceRef: 'library/sweet-caroline.mp4' });
	expect(playbackRef(local)).toBe('');
	expect(isPlayable(local)).toBe(false);
});

test('mid-cook is not playable, and a ready status without an artifact is not either', () => {
	// Rotation holds the entry while it cooks, so this ref is never requested — but it must resolve to
	// '' rather than a key that 404s.
	expect(playbackRef(m({ stemStatus: 'queued' }))).toBe('');
	// stemStatus and instrumentalRef are written by separate steps. A status that has run ahead of its
	// artifact must not hand the player an empty <video> src.
	expect(playbackRef(m({ stemStatus: 'ready', lyricsStatus: 'ready' }))).toBe('');
	expect(isPlayable(m({ stemStatus: 'ready', lyricsStatus: 'ready' }))).toBe(false);
});

test('an instrumental without a ready status is not playable either', () => {
	// The reverse skew: an artifact on disk from an interrupted or superseded cook, whose status was
	// never flipped. Playing it would resurrect a song the pipeline does not consider done.
	expect(playbackRef(m({ stemStatus: 'queued', instrumentalRef: 'stems/m1-instrumental.wav' }))).toBe('');
});
