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
// These MUST agree byte-for-byte with the worker's output paths (apps/worker/src/processor.py and
// whisperx.py), because the TV resolves `/media/${ref}`. A mismatch is silent: the file exists, the
// player 404s. Keep the two in sync or the cook→play path breaks.

/** Raw original audio. The one unrecoverable asset. */
export function audioKey(mediaId: string, ext = 'wav'): string {
	return `audio/${mediaId}.${ext.replace(/^\./, '')}`;
}
/**
 * Stored stem formats (audio policy, revised). The two stems get DIFFERENT treatment and MUST match
 * the worker's processor.py INSTRUMENTAL_EXT / VOCALS_EXT.
 *
 * - **instrumental → FLAC (lossless).** This plays out of the speakers at volume, the one place a
 *   second lossy generation is audible: the image's only AAC encoder (ffmpeg native — no libfdk_aac)
 *   smears high-frequency transients, exactly what a crash cymbal is. Lossless removes that generation.
 * - **vocals → AAC (lossy).** Nothing plays it aloud at full level; it feeds the guiding track, so
 *   transparency is not the bar.
 *
 * Songs cooked under an earlier policy keep their own (per-media) refs and still play — these helpers
 * only name NEW output.
 */
export const INSTRUMENTAL_EXT = 'flac';
export const VOCALS_EXT = 'm4a';
/** @deprecated kept so older call sites resolve; prefer the per-stem constants. */
export const STEM_EXT = VOCALS_EXT;

export function instrumentalKey(mediaId: string, ext: string = INSTRUMENTAL_EXT): string {
	return `derived/stems/${mediaId}-instrumental.${ext}`;
}
export function vocalsKey(mediaId: string, ext: string = VOCALS_EXT): string {
	return `derived/stems/${mediaId}-vocals.${ext}`;
}
export function lyricsKey(mediaId: string): string {
	return `derived/lyrics/${mediaId}.json`;
}
export function thumbKey(hash: string): string {
	return `derived/thumbs/${hash}.jpg`;
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
			return prefix + abs.slice(dir.length + 1).split(sep).join('/');
		}
	}
	return null;
}
