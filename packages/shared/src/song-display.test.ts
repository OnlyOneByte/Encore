import { test, expect } from 'bun:test';
import { songDisplay, type Media } from './index';

const m = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'djV11Xbc914',
	title: 'Britney Spears - Baby One More Time (Lyrics)',
	artist: '7clouds', // the UPLOADER — must never surface as the artist
	durationSec: 213,
	stemStatus: 'ready',
	instrumentalRef: 'stems/m1-instrumental.wav',
	...over
});

test('prefers the canonical fields when a confident parse populated them', () => {
	const d = songDisplay(m({ titleCanonical: 'Baby One More Time', artistCanonical: 'Britney Spears' }));
	expect(d.title).toBe('Baby One More Time');
	expect(d.artist).toBe('Britney Spears');
});

test('with no canonical artist, shows the title only — NEVER the uploader', () => {
	// The whole reason this helper exists: "7clouds" is a lyric channel, not the artist. A missing
	// canonical artist is an honest blank, not a fallback to provenance.
	const d = songDisplay(m({ titleCanonical: 'Baby One More Time' }));
	expect(d.title).toBe('Baby One More Time');
	expect(d.artist).toBeNull();
});

test('with no canonical title either, the raw title is the last resort for a NAME', () => {
	// The raw title still names the song (just noisily), so it is a safe title fallback — unlike the
	// uploader for the artist, which is simply wrong.
	const d = songDisplay(m());
	expect(d.title).toBe('Britney Spears - Baby One More Time (Lyrics)');
	expect(d.artist).toBeNull();
});

test('a genuine instrumental with a canonical title and no artist shows one clean line', () => {
	const d = songDisplay(m({ title: 'Some Karaoke Backing Track', titleCanonical: 'Clair de Lune', artist: undefined }));
	expect(d.title).toBe('Clair de Lune');
	expect(d.artist).toBeNull();
});

test('null / undefined media degrade to an empty title and no artist, never throwing', () => {
	expect(songDisplay(null)).toEqual({ title: '', artist: null });
	expect(songDisplay(undefined)).toEqual({ title: '', artist: null });
});
