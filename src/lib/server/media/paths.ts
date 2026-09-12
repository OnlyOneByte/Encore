// Storage layout — the SINGLE authority for where media lives.
//
// Storage is split by REPLACEABILITY, not by file type, because that is what decides backup policy,
// eviction policy, and what an operator may safely delete (docs/ARCHITECTURE.md):
//
//   state    sqlite            rebuildable from meta + a rescan       ENCORE_DATA_DIR
//   audio    raw originals     NOT regenerable — needs network, and   ENCORE_AUDIO_DIR
//                              gone forever if the source disappears
//   derived  stems/lyrics/     regenerable from audio (CPU only)      ENCORE_DERIVED_DIR
//            lyrics/thumbs
//   meta     sidecar JSON      the authoritative record               ENCORE_META_DIR
//   work     job scratch       deleted on job completion              <root>/work
//
// Every dir DEFAULTS to a subpath of MEDIA_DIR, so an existing install needs no env changes; each
// can be pointed at its own volume independently (put audio on the big disk, derived on the fast
// one). A ref stays a portable relative string like "derived/stems/<id>-instrumental.wav" — its
// FIRST SEGMENT selects which root it resolves under, which is what lets the classes live on
// different filesystems without leaking absolute paths into the DB or onto the wire.

import { join, resolve, isAbsolute, sep } from 'node:path';

/** Storage classes, in the order the spec describes them. */
export type StorageClass = 'audio' | 'derived' | 'meta' | 'work' | 'root';

/** The media root every class defaults under. */
export function mediaRoot(): string {
	return resolve(process.env.MEDIA_DIR ?? './media');
}

function dirFromEnv(envVar: string, fallbackSegment: string): string {
	const v = process.env[envVar]?.trim();
	return v ? resolve(v) : join(mediaRoot(), fallbackSegment);
}

export function audioDir(): string {
	return dirFromEnv('ENCORE_AUDIO_DIR', 'audio');
}
export function derivedDir(): string {
	return dirFromEnv('ENCORE_DERIVED_DIR', 'derived');
}
export function metaDir(): string {
	return dirFromEnv('ENCORE_META_DIR', 'meta');
}
/** Job scratch. Deliberately NOT env-configurable: it is transient and must sit next to the work. */
export function workDir(): string {
	return join(mediaRoot(), 'work');
}

/** Which class a relative ref belongs to, from its first path segment. */
export function classOf(ref: string): StorageClass {
	const head = ref.replace(/^\/+/, '').split('/')[0];
	if (head === 'audio') return 'audio';
	if (head === 'derived') return 'derived';
	if (head === 'meta') return 'meta';
	if (head === 'work') return 'work';
	return 'root'; // legacy / library files live directly under the media root
}

/** The absolute directory a ref of this class resolves under. */
export function rootForClass(cls: StorageClass): string {
	switch (cls) {
		case 'audio':
			return audioDir();
		case 'derived':
			return derivedDir();
		case 'meta':
			return metaDir();
		case 'work':
			return workDir();
		case 'root':
			return mediaRoot();
	}
}

/**
 * The base a ref resolves against, and the ref with its class prefix removed. A class dir may be
 * pointed OUTSIDE the media root, so the prefix cannot simply be joined onto the root.
 */
export function resolveBase(ref: string): { base: string; rest: string } {
	const clean = ref.replace(/^\/+/, '');
	const cls = classOf(clean);
	if (cls === 'root') return { base: mediaRoot(), rest: clean };
	return { base: rootForClass(cls), rest: clean.slice(cls.length + 1) };
}

// ── keys (relative refs — what goes in the DB and on the wire) ──────────────────────
//
// These MUST agree byte-for-byte with the worker's output paths (worker/src/processor.py),
// because the TV resolves `/media/${ref}`. A mismatch is silent: the file exists, the
// player 404s. Keep the two in sync or the process→play path breaks.

/** Raw original audio. The one unrecoverable asset. */
export function audioKey(mediaId: string, ext = 'wav'): string {
	return `audio/${mediaId}.${ext.replace(/^\./, '')}`;
}

/**
 * Every extension the retained original can be sitting under, newest-served first. The raw audio is
 * the ONLY class that cannot be regenerated, and — unlike the stems and lyrics — nothing in the core
 * ever records its real name: `Media` has no audio field and `sidecar.ts` only ever writes
 * `artifacts.audio = prev?.artifacts.audio ?? null`. So any consumer that needs to find the file has
 * to name candidates, exactly as `candidateVocalsRefs` and the caption kind×ext matrix already do for
 * their classes.
 *
 * `audioKey`'s `ext = 'wav'` default is NOT the modern name. The worker downloads to
 * `audio/<id>.%(ext)s` and then discovers what landed with `find_downloaded` (a `<id>.*` glob),
 * because — quoting `download_argv`'s docstring — the extension is whatever YouTube served. Each
 * entry below is a container `stream_quality.FORMAT_SELECTOR`
 * (`bestaudio[acodec=opus]/bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio/best`) can actually
 * produce, plus the legacy name:
 *
 * - `webm` / `opus` — the opus-preferring first clause, in its native container.
 * - `m4a` / `mp4` — the two mp4a clauses, and the muxed `/best` last resort (format 18 is mp4), which
 *   is the only thing that survives once this box's egress IP is bot-blocked.
 * - `mp3` — other extractors and declared-local uploads.
 * - `wav` — the LEGACY mislabelled name from the retired `source_audio_path` era: yt-dlp was handed a
 *   literal `audio/<id>.wav` and wrote m4a/webm bytes into it. Those files are still on the owner's
 *   volume, so dropping this entry would strand the pre-`2981662` cohort.
 *
 * This is a superset by construction and a ref whose file is absent is a no-op for every consumer
 * (`rmSync(..., { force: true })`, retention's `existsSync` skip), so naming one too many is free and
 * naming one too few permanently orphans the one unrecoverable class.
 */
export const KNOWN_AUDIO_EXTS = ['webm', 'opus', 'm4a', 'mp4', 'mp3', 'wav'] as const;

/** Every ref the retained original for `mediaId` could live at — `audioKey` at every known ext. */
export function candidateAudioRefs(mediaId: string): string[] {
	return [...new Set(KNOWN_AUDIO_EXTS.map((ext) => audioKey(mediaId, ext)))];
}
/**
 * Stored stem formats (audio policy). BOTH stems are now lossless FLAC, and both MUST match
 * the worker's processor.py INSTRUMENTAL_EXT / VOCALS_EXT.
 *
 * - **instrumental → FLAC (lossless).** This plays out of the speakers at volume, the one place a
 *   second lossy generation is audible: the image's only AAC encoder (ffmpeg native — no libfdk_aac)
 *   smears high-frequency transients, exactly what a crash cymbal is. Lossless removes that generation.
 * - **vocals → FLAC (lossless).** It plays aloud too: the guiding track is a second <audio> the TV
 *   mixes under the instrumental. Encoding it through the SAME codec/container as the instrumental
 *   means both stems decode to a sample-exact common start. The AAC-in-m4a encoder's priming samples
 *   (~21 ms at 48 kHz) used to shift the vocals start above guide-sync's 15 ms deadband, so the player
 *   trimmed it out at startup; matching codecs remove the NEED for that startup correction. FLAC
 *   in <audio> is the decode path the instrumental already uses (TvPlayer.svelte).
 *
 * Songs processed under an earlier policy keep their own (per-media) refs and still play — these helpers
 * only name NEW output. A stored `-vocals.m4a` ref from a legacy process resolves unchanged; only newly
 * processed stems land as `.flac`. AAC→FLAC recompression of existing files is deliberately NOT done
 * (see retention.ts isLegacyStemRef) — it cannot recover discarded data, only bloat the file.
 */
export const INSTRUMENTAL_EXT = 'flac';
export const VOCALS_EXT = 'flac';
/**
 * The GUIDE MIX extension. FLAC like the stems, and MUST match the worker's processor.py
 * `GUIDE_MIX_EXT` — the TV resolves `/media/<ref>`, so a mismatch 404s on a file that exists.
 */
export const GUIDE_MIX_EXT = 'flac';

export function instrumentalKey(mediaId: string, ext: string = INSTRUMENTAL_EXT): string {
	return `derived/stems/${mediaId}-instrumental.${ext}`;
}
export function vocalsKey(mediaId: string, ext: string = VOCALS_EXT): string {
	return `derived/stems/${mediaId}-vocals.${ext}`;
}

/**
 * The GUIDE MIX: both stems in ONE 4-channel file — channels 0/1 instrumental, 2/3 vocals.
 *
 * Under `derived/stems/` beside the two single-stem files it is built from, because it is exactly as
 * regenerable as they are — one ffmpeg pass over PCM separation already produced, no separation and no
 * download — so it is safe to evict first.
 *
 * It exists because two stems are two media elements, which is two decoders and two clocks. Two clocks
 * cannot be sample-locked from script: `guide-sync.ts` can only compare each element's reported
 * `currentTime`, which excludes output latency, so its governor converges on a signal that does not
 * describe what the ear hears and then stops correcting. One file has ONE playhead, so guide drift
 * becomes unrepresentable rather than governed.
 *
 * `-guidemix` rather than `-mix` deliberately: nothing here is summed. Mirrors the worker's
 * `guide_mix_path` byte-for-byte.
 */
export function guideMixKey(mediaId: string, ext: string = GUIDE_MIX_EXT): string {
	return `derived/stems/${mediaId}-guidemix.${ext}`;
}

/**
 * Every historical vocals-stem extension, newest first. A process records its vocals stem under one of
 * these; the extension a given row used depends on the VOCALS_EXT in force when it was processed (legacy
 * `.wav`, interim `.m4a` before an earlier change, current `.flac`). Retention and the guiding-track backfill both
 * need to enumerate all of them to find an existing stem whose extension differs from today's constant.
 */
export const KNOWN_VOCALS_EXTS = ['flac', 'm4a', 'wav'] as const;

/**
 * The SINGLE authority for the legacy `-instrumental.` -> `-vocals.` fallback derivation. A song processed
 * under the older layout has an instrumental ref whose sibling vocals file shares the same name; the
 * only honest fallback (when no vocals ref was stored) is the vocals sibling at EVERY known extension,
 * because the on-disk extension can differ from the instrumental's after VOCALS_EXT changes.
 *
 * This replaces the ext-blind single `.replace('-instrumental.', '-vocals.')` that had been copied to
 * three sites and drifted (/ f6f8fa7): a `.flac` instrumental swapped ext-blind names only a
 * `.flac` vocals stem, so an interim `.m4a` process became unfindable.
 */
export function siblingVocalsRef(instrumentalRef: string): string {
	return instrumentalRef.replace('-instrumental.', '-vocals.');
}

/**
 * Every ref a legacy process's vocals stem might live at — the same-extension sibling of the
 * instrumental ref (a legacy process shares one extension across both stems) re-based to every known
 * vocals extension, so a row whose on-disk vocals extension differs from today's VOCALS_EXT is still
 * named. Empty when the ref carries no `-instrumental.` marker (nothing to derive from).
 */
export function legacyVocalsRefs(instrumentalRef: string): string[] {
	const sibling = siblingVocalsRef(instrumentalRef);
	if (sibling === instrumentalRef) return [];
	const stem = sibling.replace(/\.[^.]+$/, '.');
	return KNOWN_VOCALS_EXTS.map((ext) => stem + ext);
}
export function lyricsKey(mediaId: string): string {
	return `derived/lyrics/${mediaId}.json`;
}

/**
 * Caption tiers, kept STRUCTURAL as a directory segment exactly as the worker insists (yt-dlp names
 * both tracks identically, so a filename could never tell them apart): an uploader-authored track is
 * a CANDIDATE for the song's words, a machine track is a BASELINE. MUST match the `kind` the worker's
 * `raw_caption_path` receives (`AUTHORED` / `MACHINE` in worker/src/steps/lyrics.py).
 */
export const CAPTION_KINDS = ['captions', 'auto-captions'] as const;

/**
 * Every extension a retained raw caption track can carry. The worker copies the WINNING file, whose
 * extension is preserved from what yt-dlp wrote (`.vtt`/`.srt`, worker/src/steps/lyrics.py). No
 * ref is stored on Media for it — it is debugging evidence, not a lyrics candidate — so retention must
 * enumerate every possible key, the same "candidate refs" shape `candidateVocalsRefs` uses for the
 * legacy vocals exts. A ref whose file is absent is skipped by retention's existsSync check, so
 * naming both exts per kind is free.
 */
export const KNOWN_CAPTION_EXTS = ['vtt', 'srt'] as const;

/**
 * The retained RAW caption track, keyed per media id. MUST agree byte-for-byte with the
 * worker's `raw_caption_path` (worker/src/processor.py) — the guard that pins this is in
 * vocabulary-parity.test.ts. Unlike the stems and lyrics keys this is NOT stored as a ref on Media;
 * it is regenerated on demand from (mediaId, kind, ext), which is why retention enumerates the kind/ext
 * matrix from CAPTION_KINDS × KNOWN_CAPTION_EXTS rather than reading a stored ref.
 */
export function rawCaptionKey(mediaId: string, kind: string, ext = 'vtt'): string {
	return `derived/captions/${kind}/${mediaId}.captions.${ext.replace(/^\./, '')}`;
}
/** The sidecar record — authoritative per docs/ARCHITECTURE.md. */
export function metaKey(mediaId: string): string {
	return `meta/${mediaId}.json`;
}

// ── legacy layout, kept ONLY so the migration can find things ──────────────
export const LEGACY = {
	instrumental: (id: string) => `stems/${id}-instrumental.wav`,
	vocals: (id: string) => `stems/${id}-vocals.wav`,
	lyrics: (id: string) => `lyrics/${id}.json`,
	/** Raw audio was written here as SCRATCH and never cleaned up — 432MB of it on the live box. */
	sourceAudio: (id: string) => `stems/_work/${id}/source.wav`,
	workRoot: 'stems/_work',
	thumbs: '.thumbs'
} as const;

/**
 * Normalize whatever a worker reported into a relative ref.
 *
 * Workers report ABSOLUTE paths in `job:complete` artifacts (they write into a mounted volume and hand
 * back `os.path.join(media_dir, key)`). Storing that absolute path is a bug we shipped: `safeMediaPath`
 * rejects any ref starting with "/", so an absolute `lyricsRef` could never be served — the
 * artifact existed on disk and the overlay silently got nothing. Strip any known class root back to a
 * relative key; return null if it is outside all of them (a config error, not something to store).
 */
export function toRelativeKey(uri: string | undefined | null): string | null {
	if (!uri) return null;
	const raw = uri.trim();
	if (!raw) return null;
	if (!isAbsolute(raw)) return raw.replace(/^\/+/, ''); // already relative
	const abs = resolve(raw);
	// Longest-prefix first so a class dir nested under the root (the default) wins over the root.
	const candidates: Array<[string, string]> = [
		[audioDir(), 'audio/'],
		[derivedDir(), 'derived/'],
		[metaDir(), 'meta/'],
		[workDir(), 'work/'],
		[mediaRoot(), '']
	].sort((a, b) => b[0].length - a[0].length) as Array<[string, string]>;
	for (const [dir, prefix] of candidates) {
		if (abs === dir) continue;
		if (abs.startsWith(dir + sep)) {
			return (
				prefix +
				abs
					.slice(dir.length + 1)
					.split(sep)
					.join('/')
			);
		}
	}
	return null;
}
