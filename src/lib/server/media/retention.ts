// Retention keeps derived/ volume bounded without ever losing something unrecoverable: `audio/` and
// `meta/` are NEVER touched here (audio can't be re-acquired once an upload disappears, and meta IS
// the library). Two jobs: RECOMPRESS legacy WAV stems to FLAC in place (reclaims pre-policy space, no
// re-Demucs), and EVICT derived artifacts over a soft cap (regenerable via a 1-2 min re-process). Both
// planning halves are pure so the policy is testable without a filesystem or a transcoder.

import { existsSync, statSync, rmSync } from 'node:fs';
import type { Media } from '../../contract';
import { safeMediaPath } from './local-files';
import {
	instrumentalKey,
	vocalsKey,
	guideMixKey,
	siblingVocalsRef,
	rawCaptionKey,
	CAPTION_KINDS,
	KNOWN_CAPTION_EXTS
} from './paths';
import { candidateVocalsRefs } from './vocals-backfill';
import { runCapturing } from './spawn-capture';

/** The soft cap, in bytes. Unset (the default) means unlimited — a party box must not silently delete. */
export function retentionCapBytes(env: Record<string, string | undefined> = process.env): number | null {
	const raw = env.ENCORE_MEDIA_MAX_GB?.trim();
	if (!raw) return null;
	const gb = Number(raw);
	if (!Number.isFinite(gb) || gb <= 0) return null;
	return Math.round(gb * 1e9);
}

/**
 * A stem ref worth transcoding: an UNCOMPRESSED (WAV) artifact from before the audio policy. Not
 * "anything not the current format" — that would also flag legacy `.m4a` vocals, and AAC→FLAC is
 * actively harmful (it cannot recover what the lossy encode discarded, only bloats the file). A real
 * codec upgrade off `.m4a` means re-processing from the retained raw audio, a different operation.
 */
export function isLegacyStemRef(ref: string | undefined | null): boolean {
	if (!ref) return false;
	return ref.endsWith('.wav');
}

export interface RecompressTarget {
	mediaId: string;
	/** The existing (legacy) ref, e.g. derived/stems/<id>-instrumental.wav */
	from: string;
	/** The ref it becomes, e.g. derived/stems/<id>-instrumental.flac */
	to: string;
	kind: 'instrumental' | 'vocals';
}

/** Which artifacts of these media are on a legacy format. PURE — takes the catalog, returns work.
 *  The vocals ref is derived from the key convention (not stored on Media) and existence-checked by the caller. */
export function planRecompress(all: Media[]): RecompressTarget[] {
	const out: RecompressTarget[] = [];
	for (const m of all) {
		if (isLegacyStemRef(m.instrumentalRef)) {
			out.push({ mediaId: m.id, from: m.instrumentalRef!, to: instrumentalKey(m.id), kind: 'instrumental' });
			// a legacy instrumental implies a legacy vocals stem from the same process
			out.push({ mediaId: m.id, from: siblingVocalsRef(m.instrumentalRef!), to: vocalsKey(m.id), kind: 'vocals' });
		}
	}
	return out;
}

export interface RecompressResult {
	converted: number;
	bytesBefore: number;
	bytesAfter: number;
	skipped: number;
	failed: number;
	/** mediaId → its new instrumental ref, for the caller to persist. */
	newRefs: Map<string, string>;
}

export type Transcoder = (absFrom: string, absTo: string) => Promise<boolean>;

/** Why the last transcode failed, for a diagnosable log line. Set by ffmpegTranscoder. */
export const transcodeDiagnostics: { lastError: string } = { lastError: '' };

/** Transcode legacy stems in place; one failure must not abandon the rest. The source is deleted only
 *  once the destination exists and is non-empty — losing a playable stem to a half-written encode is worse than keeping a large file. */
export async function recompressLegacyStems(
	targets: RecompressTarget[],
	transcode: Transcoder
): Promise<RecompressResult> {
	const res: RecompressResult = {
		converted: 0,
		bytesBefore: 0,
		bytesAfter: 0,
		skipped: 0,
		failed: 0,
		newRefs: new Map()
	};

	for (const t of targets) {
		const absFrom = safeMediaPath(t.from);
		const absTo = safeMediaPath(t.to);
		if (!absFrom || !absTo || !existsSync(absFrom)) {
			res.skipped++;
			// The instrumental ref still needs updating if a previous run already converted it.
			if (absTo && existsSync(absTo) && t.kind === 'instrumental') res.newRefs.set(t.mediaId, t.to);
			continue;
		}
		if (existsSync(absTo)) {
			res.skipped++;
			if (t.kind === 'instrumental') res.newRefs.set(t.mediaId, t.to);
			continue;
		}

		const before = statSync(absFrom).size;
		let ok: boolean;
		try {
			ok = await transcode(absFrom, absTo);
		} catch {
			ok = false;
		}
		if (!ok || !existsSync(absTo) || statSync(absTo).size === 0) {
			res.failed++;
			rmSync(absTo, { force: true }); // never leave a truncated artifact where a player will find it
			continue;
		}

		res.bytesBefore += before;
		res.bytesAfter += statSync(absTo).size;
		res.converted++;
		if (t.kind === 'instrumental') res.newRefs.set(t.mediaId, t.to);
		rmSync(absFrom, { force: true }); // only now is the legacy file redundant
	}
	return res;
}

export interface EvictionCandidate {
	mediaId: string;
	/** Total bytes this song's DERIVED artifacts occupy. */
	derivedBytes: number;
	/** Recency signal — lastPlayedAt when known, else addedAt. Lower is evicted first. */
	lastUsedAt: number;
}

/**
 * Which songs to strip back to un-processed, least-recently-used first, until the derived total fits
 * the cap. PURE. `protectedIds` (the currently-playing song and everything queued) is enforced HERE,
 * not left to the caller — a process stripped from under a live/queued entry vanishes mid-party
 * (stemStatus reset, stems gone, an unplayable queue entry). Protected songs still count toward the
 * total, so an unreachable cap evicts everything allowed rather than under-reporting the pressure.
 * Recency prefers `lastPlayedAt` over `addedAt`, falling back only for songs that have never played.
 */
export function planEviction(
	candidates: EvictionCandidate[],
	capBytes: number | null,
	protectedIds: ReadonlySet<string> = new Set()
): string[] {
	if (capBytes === null) return [];
	const total = candidates.reduce((n, c) => n + c.derivedBytes, 0);
	if (total <= capBytes) return [];

	const byAge = [...candidates].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
	const evict: string[] = [];
	let running = total;
	for (const c of byAge) {
		if (running <= capBytes) break;
		if (c.derivedBytes === 0) continue; // nothing to reclaim
		if (protectedIds.has(c.mediaId)) continue; // in use: playing or queued — never strip it
		evict.push(c.mediaId);
		running -= c.derivedBytes;
	}
	return evict;
}

/**
 * Every `derived/` ref a song could have on disk — the ONE list both `evictDerived` and
 * `derivedBytesOf` read (and that `media/delete.ts` reuses rather than keeping a rival list). Omitting
 * any category here undercounts `derivedBytesOf` and makes `evictDerived` orphan that file on disk
 * forever, since eviction only frees what it can name. `m.vocalsRef`/`m.guideMixRef` are authoritative
 * when the worker stored one, covering every legacy/interim/current extension; `vocalsKey`/
 * `guideMixKey` are id-derived fallbacks for old rows that never recorded a ref (harmless to include —
 * a key whose file is absent is skipped below). Every lyrics candidate is enumerated, not just the
 * chosen `lyricsRef`, or the rest are orphaned. Raw captions aren't stored as a ref at all — they're
 * enumerated per (kind, ext) from the id. Callers dedupe with a Set.
 */
export function derivedRefsOf(m: Media): string[] {
	return [
		m.instrumentalRef,
		m.lyricsRef,
		// m.vocalsRef is authoritative; candidateVocalsRefs covers old rows across every legacy extension.
		m.vocalsRef,
		...candidateVocalsRefs(m),
		// m.guideMixRef is authoritative; guideMixKey is the fallback for a row that never recorded one.
		m.guideMixRef,
		guideMixKey(m.id),
		// Every candidate's JSON, not just the chosen lyricsRef.
		...(m.lyricsCandidates ?? []).map((c) => c.ref),
		// Not stored as a ref: the worker copies captions to a deterministic per-(kind,ext) path gated
		// on ENCORE_KEEP_RAW_CAPTIONS, so they're named from the id instead.
		...CAPTION_KINDS.flatMap((kind) => KNOWN_CAPTION_EXTS.map((ext) => rawCaptionKey(m.id, kind, ext)))
	].filter((r): r is string => !!r);
}

/** Deletes a song's derived artifacts and returns the removed refs; NEVER touches `audio/` or `meta/`.
 *  The caller resets the media to un-processed so rotation stops treating it as playable. */
export function evictDerived(m: Media): { removed: string[]; bytes: number } {
	const removed: string[] = [];
	let bytes = 0;
	for (const ref of new Set(derivedRefsOf(m))) {
		const abs = safeMediaPath(ref);
		if (!abs || !existsSync(abs)) continue;
		try {
			const size = statSync(abs).size;
			// Count bytes only AFTER the delete succeeds (rmSync can still throw on EACCES/EPERM/etc.),
			// or a file left on disk gets double-counted as reclaimed.
			rmSync(abs, { force: true });
			bytes += size;
			removed.push(ref);
		} catch (err) {
			// Name the file and error rather than swallowing it, or a clean pass looks identical to one that failed silently.
			console.warn(`retention: failed to evict derived artifact ${ref}:`, err);
		}
	}
	return { removed, bytes };
}

/** Total bytes of a song's derived artifacts, for the eviction plan. Must agree with evictDerived. */
export function derivedBytesOf(m: Media): number {
	let n = 0;
	for (const ref of new Set(derivedRefsOf(m))) {
		const abs = safeMediaPath(ref);
		if (abs && existsSync(abs)) {
			try {
				n += statSync(abs).size;
			} catch {
				/* ignore */
			}
		}
	}
	return n;
}

// 120s bounds a hung ffmpeg without tripping on a genuinely long track.
const TRANSCODE_TIMEOUT_MS = 120_000;

/**
 * ffmpeg-backed transcoder: lossless stereo FLAC, matching the worker's `encode_flac_argv`, so a
 * recompressed legacy stem lands in the same codec/container a freshly processed one does — a legacy
 * WAV is itself lossless, so this is not a second lossy generation. The encoder MUST be FLAC (AAC into
 * a `.flac` container is a mismatch the muxer rejects). Returns false (not throws) when ffmpeg is
 * absent or fails, so the caller keeps the larger-but-playable original.
 */
export function ffmpegTranscoder(ffmpegBin = process.env.FFMPEG_BIN ?? 'ffmpeg'): Transcoder {
	const base = ['-hide_banner', '-loglevel', 'error', '-y'];
	const encode = ['-c:a', 'flac', '-compression_level', '8', '-sample_fmt', 's16', '-ac', '2'];

	const run = async (argv: string[]): Promise<{ ok: boolean; err: string }> => {
		// Killed after TRANSCODE_TIMEOUT_MS, or a hung ffmpeg on the detached boot chain stalls retention forever.
		const r = await runCapturing(argv, TRANSCODE_TIMEOUT_MS);
		if (r.timedOut) return { ok: false, err: `ffmpeg timed out after ${TRANSCODE_TIMEOUT_MS}ms` };
		return { ok: r.code === 0, err: r.stderr };
	};

	return async (absFrom, absTo) => {
		try {
			// A single FLAC encode into the .flac destination is the whole operation (FLAC has no moov atom, so no faststart flag applies).
			const r = await run([ffmpegBin, ...base, '-i', absFrom, ...encode, absTo]);
			if (!r.ok) transcodeDiagnostics.lastError = r.err.trim().split('\n')[0] ?? '';
			return r.ok;
		} catch (err) {
			transcodeDiagnostics.lastError = `could not run ${ffmpegBin}: ${(err as Error).message}`;
			return false; // ffmpeg absent — nothing to do but leave the file alone
		}
	};
}
