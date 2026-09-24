// The SINGLE authority for where media lives, split by REPLACEABILITY. A ref's FIRST SEGMENT selects
// which root it resolves under, so classes can sit on different filesystems without leaking absolute
// paths into the DB or wire. Four-class table: docs/ARCHITECTURE.md §6.

import { join, resolve, isAbsolute, sep } from 'node:path';

/** Storage classes. */
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
/** Deliberately NOT env-configurable: transient, and must sit next to the work. */
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
function rootForClass(cls: StorageClass): string {
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

// A class dir may point OUTSIDE the media root, so the prefix cannot simply be joined onto the root.
export function resolveBase(ref: string): { base: string; rest: string } {
	const clean = ref.replace(/^\/+/, '');
	const cls = classOf(clean);
	if (cls === 'root') return { base: mediaRoot(), rest: clean };
	return { base: rootForClass(cls), rest: clean.slice(cls.length + 1) };
}

// Every key below MUST agree byte-for-byte with the worker's output paths (worker/src/processor.py):
// the TV resolves `/media/${ref}`, so a mismatch is SILENT — the file exists and the player 404s.

/** Raw original audio. The one unrecoverable asset. */
export function audioKey(mediaId: string, ext = 'wav'): string {
	return `audio/${mediaId}.${ext.replace(/^\./, '')}`;
}

/**
 * Newest-served first. Nothing records the original's real name, so consumers must enumerate: a superset
 * is free, but one too few permanently orphans the only unrecoverable class. `wav` is a LEGACY
 * mislabelled name still holding real m4a/webm bytes.
 */
const KNOWN_AUDIO_EXTS = ['webm', 'opus', 'm4a', 'mp4', 'mp3', 'wav'] as const;

/** Every ref the retained original for `mediaId` could live at — `audioKey` at every known ext. */
export function candidateAudioRefs(mediaId: string): string[] {
	return [...new Set(KNOWN_AUDIO_EXTS.map((ext) => audioKey(mediaId, ext)))];
}
/**
 * Both lossless FLAC, matching the worker's INSTRUMENTAL_EXT/VOCALS_EXT — a mismatch silently 404s a ref
 * the DB says exists. Songs from an earlier policy keep their own refs and still play; AAC→FLAC
 * recompression is deliberately NOT done, since it cannot recover already-discarded data.
 */
export const INSTRUMENTAL_EXT = 'flac';
export const VOCALS_EXT = 'flac';
/** MUST match the worker's `GUIDE_MIX_EXT`, or a file that exists 404s. */
export const GUIDE_MIX_EXT = 'flac';

export function instrumentalKey(mediaId: string, ext: string = INSTRUMENTAL_EXT): string {
	return `derived/stems/${mediaId}-instrumental.${ext}`;
}
export function vocalsKey(mediaId: string, ext: string = VOCALS_EXT): string {
	return `derived/stems/${mediaId}-vocals.${ext}`;
}

/**
 * Both stems in ONE 4-channel file (0/1 instrumental, 2/3 vocals), so drift is unrepresentable rather
 * than merely governed. `-guidemix` not `-mix` — nothing here is summed, and it mirrors the worker's
 * `guide_mix_path` byte-for-byte.
 */
export function guideMixKey(mediaId: string, ext: string = GUIDE_MIX_EXT): string {
	return `derived/stems/${mediaId}-guidemix.${ext}`;
}

/** Newest first: a row's on-disk extension depends on VOCALS_EXT at the time it was processed. */
export const KNOWN_VOCALS_EXTS = ['flac', 'm4a', 'wav'] as const;

/**
 * The SINGLE authority for the legacy `-instrumental.` → `-vocals.` fallback. With no stored vocals ref
 * the only honest guess is the sibling at EVERY known extension, since the on-disk extension can differ
 * from the instrumental's after VOCALS_EXT changed.
 */
export function siblingVocalsRef(instrumentalRef: string): string {
	return instrumentalRef.replace('-instrumental.', '-vocals.');
}

/** The instrumental's sibling re-based to every known vocals extension. Empty when the ref carries no
 *  `-instrumental.` marker. */
export function legacyVocalsRefs(instrumentalRef: string): string[] {
	const sibling = siblingVocalsRef(instrumentalRef);
	if (sibling === instrumentalRef) return [];
	const stem = sibling.replace(/\.[^.]+$/, '.');
	return KNOWN_VOCALS_EXTS.map((ext) => stem + ext);
}
export function lyricsKey(mediaId: string): string {
	return `derived/lyrics/${mediaId}.json`;
}

/** STRUCTURAL as a directory segment: yt-dlp names both tracks identically, so only the segment
 *  distinguishes an uploader CANDIDATE from a machine BASELINE. Must match `raw_caption_path`. */
export const CAPTION_KINDS = ['captions', 'auto-captions'] as const;

/** Not stored on Media (debugging evidence, not a candidate), so retention enumerates the matrix. */
export const KNOWN_CAPTION_EXTS = ['vtt', 'srt'] as const;

/** MUST agree byte-for-byte with the worker's `raw_caption_path` (pinned by vocabulary-parity). */
export function rawCaptionKey(mediaId: string, kind: string, ext = 'vtt'): string {
	return `derived/captions/${kind}/${mediaId}.captions.${ext.replace(/^\./, '')}`;
}
/** The sidecar record — authoritative; see sidecar.ts. */
export function metaKey(mediaId: string): string {
	return `meta/${mediaId}.json`;
}

// Legacy layout, kept only so the migration can find things.
export const LEGACY = {
	instrumental: (id: string) => `stems/${id}-instrumental.wav`,
	vocals: (id: string) => `stems/${id}-vocals.wav`,
	lyrics: (id: string) => `lyrics/${id}.json`,
	/** Raw audio was written here as scratch and never cleaned up. */
	sourceAudio: (id: string) => `stems/_work/${id}/source.wav`,
	workRoot: 'stems/_work',
	thumbs: '.thumbs'
} as const;

/**
 * Workers report ABSOLUTE paths in `job:complete`, and `safeMediaPath` rejects any ref starting with
 * "/" — so an unnormalized ref can never be served even though the file exists. Null when the path
 * falls outside every known class root.
 */
export function toRelativeKey(uri: string | undefined | null): string | null {
	if (!uri) return null;
	const raw = uri.trim();
	if (!raw) return null;
	if (!isAbsolute(raw)) return raw.replace(/^\/+/, ''); // already relative
	const abs = resolve(raw);
	// Annotated BEFORE the sort, not cast after it: a bare array literal of pairs infers as `string[][]`, so the
	// comparator's `a[0]` was an optional element and the `as` cast was papering over that rather than typing it.
	const roots: Array<[string, string]> = [
		[audioDir(), 'audio/'],
		[derivedDir(), 'derived/'],
		[metaDir(), 'meta/'],
		[workDir(), 'work/'],
		[mediaRoot(), '']
	];
	// Longest-prefix first, so a class dir nested under the root (the default) wins over the root.
	const candidates = roots.sort((a, b) => b[0].length - a[0].length);
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
