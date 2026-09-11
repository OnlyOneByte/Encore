// Retention. The invariant that matters: nothing UNRECOVERABLE is ever deleted. `audio/` and
// `meta/` are untouchable; only `derived/` (regenerable from audio, at the cost of a re-cook) is fair
// game, and pre-policy WAVs are recompressed in place rather than evicted so the song stays singable.
import { afterEach, beforeEach, expect, it } from 'bun:test';
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
	derivedBytesOf,
	ffmpegTranscoder,
	transcodeDiagnostics
} from './retention';

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'r-' + id,
	title: 't-' + id,
	durationSec: 200,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
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

it('retentionCapBytes is unset by default — a party box must not silently delete', () => {
	expect(retentionCapBytes({})).toBeNull();
	expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: '' })).toBeNull();
});

it('retentionCapBytes parses gigabytes, and rejects nonsense rather than guessing', () => {
	expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: '2' })).toBe(2_000_000_000);
	expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: '0.5' })).toBe(500_000_000);
	expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: 'lots' })).toBeNull();
	expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: '-4' })).toBeNull();
	expect(retentionCapBytes({ ENCORE_MEDIA_MAX_GB: '0' })).toBeNull();
});

it('legacy-format detection flags UNCOMPRESSED artifacts only', () => {
	expect(isLegacyStemRef('derived/stems/a-instrumental.wav')).toBe(true);
	expect(isLegacyStemRef(undefined)).toBe(false);
});

it('legacy-format detection does NOT flag a lossy stem for "upgrade" to lossless — that would be actively harmful', () => {
	// When the instrumental target became FLAC, a rule of "anything not the current format" would
	// have transcoded every .m4a to FLAC. That cannot recover what AAC discarded: it produces a ~4x
	// larger file containing identical audio. A real codec upgrade means re-cooking from raw audio.
	expect(isLegacyStemRef('derived/stems/a-instrumental.m4a')).toBe(false);
	expect(isLegacyStemRef('derived/stems/a-instrumental.flac')).toBe(false);
	expect(planRecompress([media('a', { instrumentalRef: 'derived/stems/a-instrumental.m4a' })])).toEqual([]);
});

it('legacy-format detection plans both stems of a legacy cook, since they were produced together', () => {
	const targets = planRecompress([media('a', { instrumentalRef: 'derived/stems/a-instrumental.wav' }), media('b')]);
	expect(targets).toHaveLength(2); // only 'a'; 'b' is already current
	expect(targets.map((t) => t.kind).sort()).toEqual(['instrumental', 'vocals']);
	expect(targets.find((t) => t.kind === 'vocals')!.from).toBe('derived/stems/a-vocals.wav');
	expect(targets.find((t) => t.kind === 'instrumental')!.to).toBe('derived/stems/a-instrumental.flac');
});

const fakeTranscode =
	(ratio = 0.1) =>
	async (from: string, to: string) => {
		writeFileSync(to, Buffer.alloc(Math.max(1, Math.floor(readFileSync(from).length * ratio)), 2));
		return true;
	};

it('recompressLegacyStems shrinks in place, deletes the legacy file and reports the new ref', async () => {
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

it('recompressLegacyStems KEEPS the legacy file when the transcode fails — a large file beats a broken one', async () => {
	put('derived/stems/a-instrumental.wav', 1000);
	const targets = planRecompress([media('a', { instrumentalRef: 'derived/stems/a-instrumental.wav' })]);
	const res = await recompressLegacyStems(targets, async () => false);
	expect(res.failed).toBeGreaterThan(0);
	expect(res.converted).toBe(0);
	expect(existsSync(join(root, 'derived/stems/a-instrumental.wav'))).toBe(true); // still playable
});

it('recompressLegacyStems never leaves a truncated artifact where a player would find it', async () => {
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

it('recompressLegacyStems is idempotent — a second run converts nothing but still reports the ref', async () => {
	put('derived/stems/a-instrumental.wav', 1000);
	const targets = planRecompress([media('a', { instrumentalRef: 'derived/stems/a-instrumental.wav' })]);
	await recompressLegacyStems(targets, fakeTranscode());
	const again = await recompressLegacyStems(targets, fakeTranscode());
	expect(again.converted).toBe(0);
	expect(again.newRefs.get('a')).toBe('derived/stems/a-instrumental.flac');
});

const c = (id: string, bytes: number, age: number) => ({ mediaId: id, derivedBytes: bytes, lastUsedAt: age });

it('planEviction evicts nothing when there is no cap', () => {
	expect(planEviction([c('a', 1e9, 1)], null)).toEqual([]);
});

it('planEviction evicts nothing when under the cap', () => {
	expect(planEviction([c('a', 100, 1), c('b', 100, 2)], 1000)).toEqual([]);
});

it('planEviction evicts least-recently-used first, and stops as soon as it fits', () => {
	// 300 total, cap 150 → must free 150. Oldest is 'old' (100), then 'mid' (100) → 100 left, fits.
	const out = planEviction([c('new', 100, 300), c('mid', 100, 200), c('old', 100, 100)], 150);
	expect(out).toEqual(['old', 'mid']);
	expect(out).not.toContain('new'); // the freshest survives
});

it('planEviction skips songs with nothing to reclaim rather than counting them as progress', () => {
	const out = planEviction([c('empty', 0, 1), c('big', 1000, 2)], 100);
	expect(out).toEqual(['big']);
});

it('planEviction NEVER evicts a protected id — the playing or queued song survives even as the LRU candidate', () => {
	// 'old' is the least-recently-used and would be evicted first, but it is the currently-playing
	// (or queued) song. A pure-LRU plan would strip it mid-party — reset stemStatus to 'none' and
	// delete its stems out from under a live entry. The exclusion is enforced HERE so no caller can
	// forget it. It falls through to 'mid' instead to make the same room.
	const out = planEviction([c('new', 100, 300), c('mid', 100, 200), c('old', 100, 100)], 150, new Set(['old']));
	expect(out).not.toContain('old'); // protected, though it is the oldest
	expect(out).toEqual(['mid', 'new']); // freed 200 ≥ the 150 needed, oldest-first among the rest
});

it('planEviction does not evict a protected id even when nothing else can be freed', () => {
	// Only 'live' has bytes and it is protected — the plan reclaims nothing rather than touching it.
	expect(planEviction([c('live', 1000, 1)], 100, new Set(['live']))).toEqual([]);
});

it('evictDerived removes every derived artifact and reports the bytes', () => {
	put('derived/stems/a-instrumental.m4a', 500);
	put('derived/stems/a-vocals.m4a', 400);
	const m = media('a');

	expect(derivedBytesOf(m)).toBe(900);
	const { removed, bytes } = evictDerived(m);
	expect(bytes).toBe(900);
	expect(removed.length).toBe(2);
	expect(existsSync(join(root, 'derived/stems/a-instrumental.flac'))).toBe(false);
});

it('evictDerived counts the vocals stem under the CURRENT extensions, not just when they happen to match', () => {
	// The modern layout is BOTH stems FLAC. derivedBytesOf must count the vocals stem via
	// vocalsKey, which now names -vocals.flac; the ext-blind "-instrumental."→"-vocals." swap also
	// resolves it here because the two stems share .flac. derivedBytesOf feeds planEviction's cap
	// comparison, so undercounting means retention concludes there is nothing to reclaim while the
	// volume is genuinely over budget.
	put('derived/stems/a-instrumental.flac', 500);
	put('derived/stems/a-vocals.flac', 400);
	const m = media('a', { instrumentalRef: 'derived/stems/a-instrumental.flac' });

	expect(derivedBytesOf(m)).toBe(900); // and NOT 500
	// the plan and the eviction must agree, or the plan cannot predict what it frees
	expect(evictDerived(m).bytes).toBe(900);
});

it('evictDerived counts an INTERIM cook (flac instrumental + m4a vocals) via the stored m.vocalsRef', () => {
	// regression pin: flipping VOCALS_EXT to .flac makes BOTH vocalsKey and the ext-blind swap
	// derive -vocals.flac, so neither names the .m4a vocals stem an interim cook actually left on
	// disk (this PR deliberately does not recompress it). The ONLY thing that still counts it is the
	// STORED m.vocalsRef. This is the real on-disk layout, not a synthetic one. Deleting m.vocalsRef
	// from derivedRefsOf reds this (drops to 500) — proving the stored ref is load-bearing.
	// derivedBytesOf feeds planEviction's cap comparison, so an undercount makes retention reclaim
	// nothing on a volume genuinely over budget; evictDerived would also orphan the .m4a file.
	put('derived/stems/a-instrumental.flac', 500);
	put('derived/stems/a-vocals.m4a', 400);
	const m = media('a', {
		instrumentalRef: 'derived/stems/a-instrumental.flac',
		vocalsRef: 'derived/stems/a-vocals.m4a'
	});

	expect(derivedBytesOf(m)).toBe(900); // and NOT 500 — only m.vocalsRef counts the .m4a vocals here
	expect(evictDerived(m).bytes).toBe(900);
});

it('evictDerived NEVER touches audio/ or meta/ — those are the unrecoverable classes', () => {
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

it('evictDerived is safe on a song with no artifacts on disk', () => {
	expect(evictDerived(media('ghost'))).toEqual({ removed: [], bytes: 0 });
});

it('evictDerived deletes and counts ALL lyrics-candidate JSONs, not just the chosen lyricsRef', () => {
	// A song carries one lyrics JSON per text source (worker lyrics/chain.py mints a distinct key
	// each), all retained in m.lyricsCandidates; lyricsRef is only the CHOSEN one. derivedRefsOf
	// listing lyricsRef alone saw 1 of N — the other N-1 were never counted toward the cap and,
	// worse, never deleted on eviction, orphaning them on disk permanently. Enumerating every
	// candidate ref (retention.ts derivedRefsOf) is what this pins. Removing the
	// `...(m.lyricsCandidates ?? []).map((c) => c.ref)` line reds this: bytes drops to 500+200 and the
	// two extra candidate files survive.
	mkdirSync(join(root, 'derived', 'lyrics'), { recursive: true });
	put('derived/stems/a-instrumental.flac', 500);
	put('derived/lyrics/a-chosen.json', 200);
	put('derived/lyrics/a-alt1.json', 150);
	put('derived/lyrics/a-alt2.json', 120);
	const m = media('a', {
		instrumentalRef: 'derived/stems/a-instrumental.flac',
		lyricsRef: 'derived/lyrics/a-chosen.json',
		lyricsCandidates: [
			{
				ref: 'derived/lyrics/a-chosen.json',
				textSource: 'lrclib',
				timing: 'word',
				textConfidence: 'high',
				createdAt: 1
			},
			{
				ref: 'derived/lyrics/a-alt1.json',
				textSource: 'captions',
				timing: 'line',
				textConfidence: 'medium',
				createdAt: 2
			},
			{ ref: 'derived/lyrics/a-alt2.json', textSource: 'asr', timing: 'word', textConfidence: 'low', createdAt: 3 }
		]
	});

	// 500 instrumental + 200 + 150 + 120 across the three candidate JSONs = 970
	expect(derivedBytesOf(m)).toBe(970); // and NOT 700 (chosen only)
	const { removed, bytes } = evictDerived(m);
	expect(bytes).toBe(970);
	// every lyrics candidate file is gone, not just the chosen one
	expect(existsSync(join(root, 'derived/lyrics/a-chosen.json'))).toBe(false);
	expect(existsSync(join(root, 'derived/lyrics/a-alt1.json'))).toBe(false);
	expect(existsSync(join(root, 'derived/lyrics/a-alt2.json'))).toBe(false);
	expect(new Set(removed)).toEqual(
		new Set([
			'derived/stems/a-instrumental.flac',
			'derived/lyrics/a-chosen.json',
			'derived/lyrics/a-alt1.json',
			'derived/lyrics/a-alt2.json'
		])
	);
});

it('evictDerived counts AND evicts the retained raw caption track the cap claims to bound', () => {
	// THE F1 PIN. ENCORE_KEEP_RAW_CAPTIONS retention shipped with a docstring claiming the track
	// "inherits the retention the cap already bounds" — but eviction here is ref-driven and
	// derivedRefsOf enumerated no raw-caption key, so derivedBytesOf undercounted (the identical
	// lyrics-candidate undercount) and evictDerived orphaned the file on disk PERMANENTLY: retention strips
	// the song to un-cooked and the raw caption survives the eviction with nothing left pointing at it.
	// The worker writes it to derived/captions/<kind>/<id>.captions.<ext> keyed per media id (no ref
	// stored on Media), so derivedRefsOf enumerates CAPTION_KINDS × KNOWN_CAPTION_EXTS via rawCaptionKey.
	// Removing that enumeration line reds this: bytes drops to 500 and both caption files survive.
	mkdirSync(join(root, 'derived', 'captions', 'captions'), { recursive: true });
	mkdirSync(join(root, 'derived', 'captions', 'auto-captions'), { recursive: true });
	put('derived/stems/a-instrumental.flac', 500);
	put('derived/captions/captions/a.captions.vtt', 70); // authored, .vtt
	put('derived/captions/auto-captions/a.captions.srt', 90); // machine, .srt (both known exts covered)
	const m = media('a', { instrumentalRef: 'derived/stems/a-instrumental.flac' });

	expect(derivedBytesOf(m)).toBe(660); // 500 + 70 + 90, and NOT 500 (raw caption tracks omitted)
	const { removed, bytes } = evictDerived(m);
	expect(bytes).toBe(660);
	// the retained raw tracks are actually reclaimed, not orphaned
	expect(existsSync(join(root, 'derived/captions/captions/a.captions.vtt'))).toBe(false);
	expect(existsSync(join(root, 'derived/captions/auto-captions/a.captions.srt'))).toBe(false);
	expect(new Set(removed)).toEqual(
		new Set([
			'derived/stems/a-instrumental.flac',
			'derived/captions/captions/a.captions.vtt',
			'derived/captions/auto-captions/a.captions.srt'
		])
	);
});

// ── retention must report bytes it actually freed, and derive the vocals ref in ONE place ──
import { readFileSync as _readFileSync } from 'node:fs';
import { chmodSync, statSync as _statSync } from 'node:fs';
import { join as _join } from 'node:path';

// Strip block and line comments so a scan measures LOGIC, not the prose that describes the old form.
// retention.ts's docstrings mention `-instrumental.` in prose, which would satisfy a naive scan.
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const mediaSrcDir = _join(import.meta.dir);
const readSrc = (name: string) => _readFileSync(_join(mediaSrcDir, name), 'utf8');

it('§1 — evictDerived reports only bytes it actually freed: counts ZERO bytes for a file it could not delete, and leaves it on disk', () => {
	// The reachable trigger: a derived file `existsSync` can see but `rmSync` cannot dispose of.
	// `force` suppresses ENOENT only; EACCES/EPERM/EROFS/EBUSY still throw. We reproduce EACCES by
	// making the parent directory non-writable. Root ignores mode bits, so skip under uid 0.
	if (process.getuid?.() === 0) return; // root ignores mode bits — the throw cannot be reproduced
	put('derived/stems/a-instrumental.flac', 4096);
	const parent = _join(root, 'derived', 'stems');
	chmodSync(parent, 0o555); // read+execute, no write → unlink throws EACCES
	try {
		const { removed, bytes } = evictDerived(media('a', { instrumentalRef: 'derived/stems/a-instrumental.flac' }));
		// BASE (count-before-delete) reported bytes = 4096 for a file still on disk. Fixed: 0.
		expect(bytes).toBe(0);
		expect(removed).toEqual([]);
		expect(existsSync(_join(root, 'derived/stems/a-instrumental.flac'))).toBe(true);
	} finally {
		chmodSync(parent, 0o755); // restore so afterEach can rmSync the tree
	}
});

it('§1 — evictDerived reports only bytes it actually freed: binds the disposal error and logs it — a swallowed failure is undiagnosable', () => {
	// Portable structural guard (the behavioural arm above needs a non-root uid). Two invariants:
	// (1) the byte count happens AFTER the disposal call, not before; (2) the catch binds the error
	// and logs it rather than being a bare `catch {}`. Both red on base.
	const body = stripComments(readSrc('retention.ts'));
	const fn = body.match(/export function evictDerived[\s\S]*?\n}/);
	expect(fn).not.toBeNull();
	const evict = fn![0];

	const rmAt = evict.indexOf('rmSync(');
	const countAt = evict.indexOf('bytes +=');
	expect(rmAt).toBeGreaterThan(-1); // disposal-call anchor found
	expect(countAt).toBeGreaterThan(-1); // count anchor found
	// count AFTER disposal: BASE FAILS (count precedes rmSync)
	expect(countAt).toBeGreaterThan(rmAt);
	// error is bound and logged: BASE FAILS (bare `catch {}` with no console call)
	expect(evict).toMatch(/catch\s*\(/);
	expect(evict).toMatch(/console\.(warn|error)/);
});

it('§2 — the vocals ref is derived in exactly one place: the -instrumental.->-vocals. substitution appears exactly ONCE in production source', () => {
	// GUARD 1: comments stripped, scan retention.ts / vocals-backfill.ts / paths.ts. BASE = 3
	// (retention.ts: 2, vocals-backfill.ts: 1). After the extraction into paths.ts it is 1.
	const swap = /\.replace\(\s*['"]-instrumental\.['"]\s*,\s*['"]-vocals\.['"]\s*\)/g;
	const files = ['retention.ts', 'vocals-backfill.ts', 'paths.ts'];
	const hits = files.reduce((n, f) => n + (stripComments(readSrc(f)).match(swap)?.length ?? 0), 0);
	expect(hits).toBeGreaterThan(0); // sentinel: fails loudly if the anchor ever disappears entirely
	expect(hits).toBe(1);
});

it('§2 — the vocals ref is derived in exactly one place: proves comment-stripping is load-bearing, not decorative', () => {
	// The raw source mentions the swap more often than the stripped source (the docstrings describe
	// it). Passes on base; fails honestly the day the comments stop mentioning it.
	const raw = readSrc('retention.ts');
	const rawCount = (raw.match(/-instrumental\./g) ?? []).length;
	const strippedCount = (stripComments(raw).match(/-instrumental\./g) ?? []).length;
	expect(rawCount).toBeGreaterThan(strippedCount);
});

it('§2 — the vocals ref is derived in exactly one place: derivedRefsOf reads the shared candidate list AND retains the stored ref', () => {
	// GUARD 3: retention re-derived its own list; it must delegate to candidateVocalsRefs.
	// The m.vocalsRef arm is a regression guard: it must still be present.
	const body = stripComments(readSrc('retention.ts'));
	const fn = body.match(/function derivedRefsOf[\s\S]*?\n}/);
	expect(fn).not.toBeNull();
	expect(fn![0]).toContain('candidateVocalsRefs'); // BASE FAILS: re-derived inline
	expect(fn![0]).toContain('m.vocalsRef'); // regression guard — passes today
});

// ── the recompress encoder must emit FLAC into the .flac destination it plans ──
// The suite's fakeTranscode writes bytes at `to` and returns true, IGNORING the destination extension
// and the codec entirely — so before this block, mutating the production argv to `-c:a aac` (or any
// codec) left the whole suite green (mutation-proven). These tests exercise the REAL
// `ffmpegTranscoder` end-to-end by pointing it at a fake `ffmpeg` executable that records the argv it
// is handed, so the codec the production builder emits is asserted rather than assumed. ffmpeg need
// not be installed on the box: the fake IS the ffmpeg the transcoder spawns.
import { chmodSync as _chmodSync } from 'node:fs';

// Write a fake `ffmpeg` that appends every argv it receives (one JSON array per invocation) to
// $argvLog, then produces the requested output file so the transcoder's success path runs. Returns
// the absolute path to the fake bin.
const writeFakeFfmpeg = (argvLog: string): string => {
	const bin = join(root, 'fake-ffmpeg.sh');
	// Record the argv robustly: one arg per line, then a lone "---" marker terminating the
	// invocation, then produce the output file (last arg) so the transcoder's success path runs.
	// A line-per-arg log sidesteps shell quoting entirely (no JSON hand-encoding in bash).
	writeFileSync(
		bin,
		[
			'#!/usr/bin/env bash',
			'set -euo pipefail',
			`for a in "$@"; do printf '%s\\n' "$a" >> "${argvLog}"; done`,
			`printf -- '---\\n' >> "${argvLog}"`,
			'out="${@: -1}"',
			'printf "FLACfake" > "$out"',
			''
		].join('\n')
	);
	_chmodSync(bin, 0o755);
	return bin;
};

it('the legacy-stem recompress encoder matches its .flac destination: builds a FLAC encode for a .flac destination — NOT AAC (mutation-proven on the real argv)', async () => {
	const argvLog = join(root, 'argv.log');
	const fakeBin = writeFakeFfmpeg(argvLog);
	put('derived/stems/a-instrumental.wav', 1000);

	const transcode = ffmpegTranscoder(fakeBin);
	const ok = await transcode(
		join(root, 'derived/stems/a-instrumental.wav'),
		join(root, 'derived/stems/a-instrumental.flac')
	);
	expect(ok).toBe(true);

	const invocations = readFileSync(argvLog, 'utf8')
		.split('---\n')
		.map((chunk) => chunk.split('\n').filter((l) => l.length > 0))
		.filter((argvv) => argvv.length > 0);
	expect(invocations.length).toBeGreaterThan(0); // the transcoder actually spawned the encoder
	const argv = invocations[0];

	// The destination is a .flac ref, so the codec MUST be flac. BASE FAILS: base emits `-c:a aac`.
	const ca = argv.indexOf('-c:a');
	expect(ca).toBeGreaterThan(-1);
	expect(argv[ca + 1]).toBe('flac');

	// And it must NOT carry the retired AAC encoder or its bitrate knob into a .flac container.
	expect(argv).not.toContain('aac');
	expect(argv).not.toContain('192k');
	// `-movflags +faststart` is an MP4/MOV concern that is dead once the output is FLAC.
	expect(argv).not.toContain('-movflags');

	// The planned destination really is .flac, so the codec/container agree.
	const out = argv[argv.length - 1];
	expect(out.endsWith('.flac')).toBe(true);
});

it('the legacy-stem recompress encoder matches its .flac destination: reports failure and leaves the source WAV when the encoder genuinely fails', async () => {
	// A fake ffmpeg that exits non-zero (a real encode error, not a missing binary) must degrade to
	// keeping the larger-but-playable original — the caller's failure contract is unchanged by the
	// codec fix. Also confirms the single-invocation path (no MP4 faststart retry) still reports.
	transcodeDiagnostics.lastError = '';
	const failBin = join(root, 'fail-ffmpeg.sh');
	writeFileSync(failBin, '#!/usr/bin/env bash\necho "boom" >&2\nexit 1\n');
	_chmodSync(failBin, 0o755);
	put('derived/stems/a-instrumental.wav', 1000);

	const transcode = ffmpegTranscoder(failBin);
	const ok = await transcode(
		join(root, 'derived/stems/a-instrumental.wav'),
		join(root, 'derived/stems/a-instrumental.flac')
	);
	expect(ok).toBe(false);
	expect(existsSync(join(root, 'derived/stems/a-instrumental.wav'))).toBe(true); // still playable
	expect(transcodeDiagnostics.lastError).toContain('boom');
});
