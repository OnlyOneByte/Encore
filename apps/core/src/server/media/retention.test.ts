// Retention. The invariant that matters: nothing UNRECOVERABLE is ever deleted. `audio/` and
// `meta/` are untouchable; only `derived/` (regenerable from audio, at the cost of a re-cook) is fair
// game, and pre-policy WAVs are recompressed in place rather than evicted so the song stays singable.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Media } from '@encore/shared';
import {
	retentionCapBytes,
	isLegacyStemRef,
	planRecompress,
	recompressLegacyStems,
	planEviction,
	evictDerived,
	derivedBytesOf
} from './retention';

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'r-' + id,
	title: 't-' + id,
	durationSec: 200,
	stemStatus: 'ready', lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.m4a`,
	...over
});

let root: string;
let saved: string | undefined;

beforeEach(() => {
	saved = process.env.MEDIA_DIR;
	root = mkdtempSync(join(tmpdir(), 'encore-ret-'));
	process.env.MEDIA_DIR = root;
	mkdirSync(join(root, 'derived', 'stems'), { recursive: true });
});
afterEach(() => {
	if (saved === undefined) delete process.env.MEDIA_DIR;
	else process.env.MEDIA_DIR = saved;
	rmSync(root, { recursive: true, force: true });
});

const put = (rel: string, bytes: number) => writeFileSync(join(root, ...rel.split('/')), Buffer.alloc(bytes, 1));

describe('retentionCapBytes', () => {
	it('is unset by default — a party box must not silently delete', () => {
		expect(retentionCapBytes({})).toBeNull();
		expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: '' })).toBeNull();
	});

	it('parses gigabytes, and rejects nonsense rather than guessing', () => {
		expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: '2' })).toBe(2_000_000_000);
		expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: '0.5' })).toBe(500_000_000);
		expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: 'lots' })).toBeNull();
		expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: '-4' })).toBeNull();
		expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: '0' })).toBeNull();
	});
});

describe('legacy-format detection', () => {
	it('flags UNCOMPRESSED artifacts only', () => {
		expect(isLegacyStemRef('derived/stems/a-instrumental.wav')).toBe(true);
		expect(isLegacyStemRef(undefined)).toBe(false);
	});

	it('does NOT flag a lossy stem for "upgrade" to lossless — that would be actively harmful', () => {
		// When the instrumental target became FLAC, a rule of "anything not the current format" would
		// have transcoded every .m4a to FLAC. That cannot recover what AAC discarded: it produces a ~4x
		// larger file containing identical audio. A real codec upgrade means re-cooking from raw audio.
		expect(isLegacyStemRef('derived/stems/a-instrumental.m4a')).toBe(false);
		expect(isLegacyStemRef('derived/stems/a-instrumental.flac')).toBe(false);
		expect(planRecompress([media('a', { instrumentalRef: 'derived/stems/a-instrumental.m4a' })])).toEqual([]);
	});

	it('plans both stems of a legacy cook, since they were produced together', () => {
		const targets = planRecompress([media('a', { instrumentalRef: 'derived/stems/a-instrumental.wav' }), media('b')]);
		expect(targets).toHaveLength(2); // only 'a'; 'b' is already current
		expect(targets.map((t) => t.kind).sort()).toEqual(['instrumental', 'vocals']);
		expect(targets.find((t) => t.kind === 'vocals')!.from).toBe('derived/stems/a-vocals.wav');
		expect(targets.find((t) => t.kind === 'instrumental')!.to).toBe('derived/stems/a-instrumental.flac');
	});
});

describe('recompressLegacyStems', () => {
	const fakeTranscode = (ratio = 0.1) => async (from: string, to: string) => {
		writeFileSync(to, Buffer.alloc(Math.max(1, Math.floor(readFileSync(from).length * ratio)), 2));
		return true;
	};

	it('shrinks in place, deletes the legacy file and reports the new ref', async () => {
		put('derived/stems/a-instrumental.wav', 1000);
		put('derived/stems/a-vocals.wav', 1000);
		const targets = planRecompress([media('a', { instrumentalRef: 'derived/stems/a-instrumental.wav' })]);

		const res = await recompressLegacyStems(targets, fakeTranscode());
		expect(res.converted).toBe(2);
		expect(res.bytesBefore).toBe(2000);
		expect(res.bytesAfter).toBe(200);
		expect(res.newRefs.get('a')).toBe('derived/stems/a-instrumental.flac');
		expect(existsSync(join(root, 'derived/stems/a-instrumental.flac'))).toBe(true);
		expect(existsSync(join(root, 'derived/stems/a-instrumental.wav'))).toBe(false); // reclaimed
	});

	it('KEEPS the legacy file when the transcode fails — a large file beats a broken one', async () => {
		put('derived/stems/a-instrumental.wav', 1000);
		const targets = planRecompress([media('a', { instrumentalRef: 'derived/stems/a-instrumental.wav' })]);
		const res = await recompressLegacyStems(targets, async () => false);
		expect(res.failed).toBeGreaterThan(0);
		expect(res.converted).toBe(0);
		expect(existsSync(join(root, 'derived/stems/a-instrumental.wav'))).toBe(true); // still playable
	});

	it('never leaves a truncated artifact where a player would find it', async () => {
		put('derived/stems/a-instrumental.wav', 1000);
		const targets = planRecompress([media('a', { instrumentalRef: 'derived/stems/a-instrumental.wav' })]);
		// a transcoder that "succeeds" but writes nothing
		await recompressLegacyStems(targets, async (_f, to) => {
			writeFileSync(to, Buffer.alloc(0));
			return true;
		});
		expect(existsSync(join(root, 'derived/stems/a-instrumental.flac'))).toBe(false);
		expect(existsSync(join(root, 'derived/stems/a-instrumental.wav'))).toBe(true);
	});

	it('is idempotent — a second run converts nothing but still reports the ref', async () => {
		put('derived/stems/a-instrumental.wav', 1000);
		const targets = planRecompress([media('a', { instrumentalRef: 'derived/stems/a-instrumental.wav' })]);
		await recompressLegacyStems(targets, fakeTranscode());
		const again = await recompressLegacyStems(targets, fakeTranscode());
		expect(again.converted).toBe(0);
		expect(again.newRefs.get('a')).toBe('derived/stems/a-instrumental.flac');
	});
});

describe('planEviction', () => {
	const c = (id: string, bytes: number, age: number) => ({ mediaId: id, derivedBytes: bytes, lastUsedAt: age });

	it('evicts nothing when there is no cap', () => {
		expect(planEviction([c('a', 1e9, 1)], null)).toEqual([]);
	});

	it('evicts nothing when under the cap', () => {
		expect(planEviction([c('a', 100, 1), c('b', 100, 2)], 1000)).toEqual([]);
	});

	it('evicts least-recently-used first, and stops as soon as it fits', () => {
		// 300 total, cap 150 → must free 150. Oldest is 'old' (100), then 'mid' (100) → 100 left, fits.
		const out = planEviction([c('new', 100, 300), c('mid', 100, 200), c('old', 100, 100)], 150);
		expect(out).toEqual(['old', 'mid']);
		expect(out).not.toContain('new'); // the freshest survives
	});

	it('skips songs with nothing to reclaim rather than counting them as progress', () => {
		const out = planEviction([c('empty', 0, 1), c('big', 1000, 2)], 100);
		expect(out).toEqual(['big']);
	});
});

describe('evictDerived', () => {
	it('removes every derived artifact and reports the bytes', () => {
		put('derived/stems/a-instrumental.m4a', 500);
		put('derived/stems/a-vocals.m4a', 400);
		const m = media('a');

		expect(derivedBytesOf(m)).toBe(900);
		const { removed, bytes } = evictDerived(m);
		expect(bytes).toBe(900);
		expect(removed.length).toBe(2);
		expect(existsSync(join(root, 'derived/stems/a-instrumental.flac'))).toBe(false);
	});

	it('NEVER touches audio/ or meta/ — those are the unrecoverable classes', () => {
		mkdirSync(join(root, 'audio'), { recursive: true });
		mkdirSync(join(root, 'meta'), { recursive: true });
		put('audio/a.webm', 900);
		put('meta/a.json', 50);
		put('derived/stems/a-instrumental.m4a', 500);

		evictDerived(media('a'));
		expect(existsSync(join(root, 'audio/a.webm'))).toBe(true); // cannot be re-acquired
		expect(existsSync(join(root, 'meta/a.json'))).toBe(true); // IS the library
		expect(existsSync(join(root, 'derived/stems/a-instrumental.flac'))).toBe(false);
	});

	it('is safe on a song with no artifacts on disk', () => {
		expect(evictDerived(media('ghost'))).toEqual({ removed: [], bytes: 0 });
	});
});
