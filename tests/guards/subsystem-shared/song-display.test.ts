import { test, expect } from 'bun:test';
import { type Media } from '$lib/contract';
import { songDisplay } from '$lib/contract';

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
	// "7clouds" is a lyric channel, not the artist: a missing canonical artist is an honest blank.
	const d = songDisplay(m({ titleCanonical: 'Baby One More Time' }));
	expect(d.title).toBe('Baby One More Time');
	expect(d.artist).toBeNull();
});

test('with no canonical title either, the raw title is the last resort for a NAME', () => {
	// The raw title still names the song, just noisily — unlike the uploader, which is simply wrong.
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

// The display-title rule (`titleCanonical ?? …title`) lives ONLY in songDisplay, so the next change to "what
// title a guest sees" is one edit. Every copy agrees today, so no behavioural test moves when they are
// consolidated — hence a comment-stripped source scan.
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

const SELF = at('src/lib/contract/presentation/song-display.ts');
const STATS = at('src/routes/api/stats/+server.ts');
const METRICS = at('src/routes/api/metrics/+server.ts');

// LOOSE on purpose: song-display.ts states the rule in prose with no object prefix, so a stricter
// `\w+\.title` would count raw == stripped there and never prove that comment-stripping is load-bearing.
const DISPLAY_TITLE = /titleCanonical\s*\?\?\s*[A-Za-z_$.?]*title/g;

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
function count(path: string): number {
	return (stripComments(readFileSync(path, 'utf8')).match(DISPLAY_TITLE) ?? []).length;
}

test('the display-title rule appears exactly once in the codebase — inside songDisplay itself', () => {
	// Sentinel: count===1 PLUS the anchor, so a rename fails loudly rather than passing on a vanished symbol.
	const self = readFileSync(SELF, 'utf8');
	expect(self).toContain('export function songDisplay');
	expect(count(SELF)).toBe(1);
});

test('the /api/stats route does not re-implement the display-title rule — it calls songDisplay()', () => {
	// `songDisplay(` not the bare identifier: a revert to raw m.title that leaves the import behind would
	// still pass on the bare id.
	expect(count(STATS)).toBe(0);
	expect(readFileSync(STATS, 'utf8')).toContain('songDisplay(');
});

test('the /api/metrics route does not re-implement the display-title rule — it calls songDisplay()', () => {
	expect(count(METRICS)).toBe(0);
	expect(readFileSync(METRICS, 'utf8')).toContain('songDisplay(');
});
