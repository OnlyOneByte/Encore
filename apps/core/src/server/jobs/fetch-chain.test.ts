// The acquisition CHAIN: a cook starts by getting the bytes, then separates them.
//
// Kept separate from the separator-routing tests because the failure it guards against is different:
// enqueueing `stems` directly would dispatch a separation before its input existed, and a `fetch`
// that chained to nothing would leave every song stuck with audio on disk and no instrumental.
import { test, expect } from 'bun:test';
import { followUps, requiredCapability, assignParams } from './dispatch';
import { DEFAULT_GLOBAL_SETTINGS, type GlobalSettings, type Media } from '@encore/shared';

const settings = (o: Partial<GlobalSettings> = {}): GlobalSettings => ({ ...DEFAULT_GLOBAL_SETTINGS, ...o });
const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Take On Me',
	durationSec: 225,
	stemStatus: 'none',
	...over
});

test('fetch chains to stems — acquisition is never a dead end', () => {
	expect(followUps('fetch', settings())).toEqual(['stems']);
});

test('fetch does NOT chain align/score directly — those need the vocals stem', () => {
	// align and score read the isolated vocals, which only exists after separation. Chaining them off
	// fetch would race the separation that produces their input.
	const next = followUps('fetch', settings());
	expect(next).not.toContain('align');
	expect(next).not.toContain('score');
});

test('fetch routes on the DOWNLOADER capability, not on stems', () => {
	// This is what lets a box that can pull audio and a box that can separate it be different
	// machines: neither capability implies the other.
	expect(requiredCapability('fetch', settings())).toBe('fetch:ytdlp');
	expect(requiredCapability('stems', settings())).toBe('stems');
	expect(requiredCapability('fetch', settings())).not.toBe(requiredCapability('stems', settings()));
});

test('fetch capability falls back sanely with no settings at all (older callers, unit tests)', () => {
	expect(requiredCapability('fetch')).toBe('fetch:ytdlp');
});

test('every job that touches source audio declares HOW to obtain it', () => {
	// The worker parses this at its boundary instead of testing the URI for an http prefix.
	for (const jobType of ['fetch', 'stems', 'stems-upgrade', 'align'] as const) {
		expect(assignParams(jobType, media(), settings()).fetcher).toBe('ytdlp');
	}
});

test('a LOCAL media declares `local`, so the worker reads a path instead of downloading', () => {
	const local = media({ source: 'local', sourceRef: 'library/x.mp4' });
	expect(assignParams('stems', local, settings()).fetcher).toBe('local');
	// and it is `local` even though the deployment's downloader is yt-dlp — the bytes are already here
	expect(assignParams('fetch', local, settings({ defaultFetcher: 'ytdlp' })).fetcher).toBe('local');
});

test('a fetch job carries no separator params — it produces nothing singable', () => {
	const p = assignParams('fetch', media(), settings());
	expect(p.engine).toBeUndefined();
	expect(p.model).toBeUndefined();
});
