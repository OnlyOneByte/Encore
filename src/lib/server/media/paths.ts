// Storage layout — the SINGLE authority for where media lives, split by REPLACEABILITY (backup and
// eviction policy, what an operator may safely delete). See docs/ARCHITECTURE.md
// #media-storage-and-paths for the full four-class table. Each dir defaults under MEDIA_DIR but can
// point at its own volume. A ref like "derived/stems/<id>-instrumental.wav" has its FIRST SEGMENT
// select which root it resolves under, letting classes live on different filesystems without
// leaking absolute paths into the DB or wire.

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

// The base a ref resolves against, and the ref with its class prefix removed — a class dir may be
// pointed OUTSIDE the media root, so the prefix can't simply be joined onto the root.
export function resolveBase(ref: string): { base: string; rest: string } {
	const clean = ref.replace(/^\/+/, '');
	const cls = classOf(clean);
	if (cls === 'root') return { base: mediaRoot(), rest: clean };
	return { base: rootForClass(cls), rest: clean.slice(cls.length + 1) };
}

// keys (relative refs stored in the DB and sent over the wire) MUST agree byte-for-byte with the
// worker's output paths (worker/src/processor.py) — the TV resolves `/media/${ref}`, so a mismatch
// is silent: the file exists, the player 404s.

/** Raw original audio. The one unrecoverable asset. */
export function audioKey(mediaId: string, ext = 'wav'): string {
	return `audio/${mediaId}.${ext.replace(/^\./, '')}`;
}

/**
 * Every extension the retained original could be sitting under, newest-served first. Nothing
 * records its real name (sidecar.ts only writes `artifacts.audio = prev?.artifacts.audio ?? null`),
 * so consumers must enumerate candidates: a superset is free, but naming one too few permanently
 * orphans the one unrecoverable class. `wav` is a LEGACY mislabelled name still holding real m4a/webm bytes.
 */
export const KNOWN_AUDIO_EXTS = ['webm', 'opus', 'm4a', 'mp4', 'mp3', 'wav'] as const;

/** Every ref the retained original for `mediaId` could live at — `audioKey` at every known ext. */
export function candidateAudioRefs(mediaId: string): string[] {
	return [...new Set(KNOWN_AUDIO_EXTS.map((ext) => audioKey(mediaId, ext)))];
}
/**
 * Stored stem formats: both lossless FLAC, matching the worker's INSTRUMENTAL_EXT/VOCALS_EXT — a
 * mismatch silently 404s a ref the DB says exists (see docs/ARCHITECTURE.md
 * #media-storage-and-paths for the full audio-policy rationale). Songs from an earlier policy keep
 * their own refs and still play; AAC→FLAC recompression is deliberately NOT done (retention.ts
 * isLegacyStemRef) — it can't recover already-discarded data.
 */
export const INSTRUMENTAL_EXT = 'flac';
export const VOCALS_EXT = 'flac';
/** GUIDE MIX extension: FLAC like the stems, MUST match the worker's `GUIDE_MIX_EXT` — the TV
 *  resolves `/media/<ref>`, so a mismatch 404s a file that exists. */
export const GUIDE_MIX_EXT = 'flac';

export function instrumentalKey(mediaId: string, ext: string = INSTRUMENTAL_EXT): string {
	return `derived/stems/${mediaId}-instrumental.${ext}`;
}
export function vocalsKey(mediaId: string, ext: string = VOCALS_EXT): string {
	return `derived/stems/${mediaId}-vocals.${ext}`;
}

/**
 * The GUIDE MIX: both stems in ONE 4-channel file (0/1 instrumental, 2/3 vocals) — one playhead, so
 * drift is unrepresentable rather than merely governed (see docs/ARCHITECTURE.md
 * #media-storage-and-paths for why two elements can't be sample-locked from script). Lives beside
 * the stems it's built from — equally regenerable, safe to evict first. `-guidemix` not `-mix`:
 * nothing here is summed, mirroring the worker's `guide_mix_path` byte-for-byte.
 */
export function guideMixKey(mediaId: string, ext: string = GUIDE_MIX_EXT): string {
	return `derived/stems/${mediaId}-guidemix.${ext}`;
}

/**
 * Every historical vocals-stem extension, newest first — a row's on-disk extension depends on
 * VOCALS_EXT at the time it was processed. Retention and the guide backfill enumerate all of them.
 */
export const KNOWN_VOCALS_EXTS = ['flac', 'm4a', 'wav'] as const;

/**
 * The SINGLE authority for the legacy `-instrumental.` → `-vocals.` fallback: the only honest guess
 * (no stored vocals ref) is the sibling at EVERY known extension, since the on-disk extension can
 * differ from the instrumental's after VOCALS_EXT changed.
 */
export function siblingVocalsRef(instrumentalRef: string): string {
	return instrumentalRef.replace('-instrumental.', '-vocals.');
}

/**
 * Every ref a legacy process's vocals stem might live at: the instrumental's same-extension sibling
 * re-based to every known vocals extension. Empty when the ref carries no `-instrumental.` marker.
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
 * Caption tiers, kept STRUCTURAL as a directory segment — yt-dlp names both tracks identically, so
 * only the segment distinguishes an uploader CANDIDATE from a machine BASELINE. Must match the
 * worker's `raw_caption_path` kind (`AUTHORED`/`MACHINE`).
 */
export const CAPTION_KINDS = ['captions', 'auto-captions'] as const;

/**
 * Every extension a retained raw caption track can carry. Not stored on Media — it's debugging
 * evidence, not a lyrics candidate — so retention enumerates the kind×ext matrix itself.
 */
export const KNOWN_CAPTION_EXTS = ['vtt', 'srt'] as const;

/**
 * The retained RAW caption track. MUST agree byte-for-byte with the worker's `raw_caption_path`
 * (pinned by vocabulary-parity.test.ts); not stored on Media — regenerated on demand.
 */
export function rawCaptionKey(mediaId: string, kind: string, ext = 'vtt'): string {
	return `derived/captions/${kind}/${mediaId}.captions.${ext.replace(/^\./, '')}`;
}
/** The sidecar record — authoritative per docs/ARCHITECTURE.md. */
export function metaKey(mediaId: string): string {
	return `meta/${mediaId}.json`;
}

// Legacy layout, kept only so the migration can find things.
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
 * Normalize whatever a worker reported into a relative ref. Workers report ABSOLUTE paths in
 * `job:complete`; storing that verbatim is a bug already shipped once — `safeMediaPath` rejects any
 * ref starting with "/", so an absolute ref could never be served even though the file exists.
 * Strip a known class root to a relative key; null if outside all of them.
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
