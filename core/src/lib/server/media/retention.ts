// `meta/` and an upload's `audio/` are NEVER touched here: that audio cannot be re-acquired, and meta IS the
// library. A fetched song's kept original can, so it is evicted with its derived files. Two jobs — RECOMPRESS
// legacy WAV stems in place, and EVICT derived artifacts over a soft cap. Both planning halves are pure, so the
// policy tests without a filesystem.

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
import { clearArtifacts } from './sidecar';
import { forgetProcess } from '../jobs/process';
import type { JobRepository } from '../jobs/repository';

/** The soft cap, in bytes. Unset (the default) means unlimited — a party box must not silently delete. */
export function retentionCapBytes(env: Record<string, string | undefined> = process.env): number | null {
	const raw = env.ENCORE_MEDIA_MAX_GB?.trim();
	if (!raw) return null;
	const gb = Number(raw);
	if (!Number.isFinite(gb) || gb <= 0) return null;
	return Math.round(gb * 1e9);
}

/**
 * UNCOMPRESSED (WAV) only, NOT "anything not the current format": that would also flag legacy `.m4a`
 * vocals, and AAC→FLAC only bloats a file without recovering what the lossy encode discarded. A real
 * codec upgrade off `.m4a` means re-processing from retained raw audio, a different operation.
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

/** PURE. The vocals ref is derived from the key convention, not stored on Media, and is
 *  existence-checked by the caller. */
export function planRecompress(all: Media[]): RecompressTarget[] {
	const out: RecompressTarget[] = [];
	for (const m of all) {
		if (isLegacyStemRef(m.instrumentalRef)) {
			out.push({ mediaId: m.id, from: m.instrumentalRef!, to: instrumentalKey(m.id), kind: 'instrumental' });
			// A legacy instrumental implies a legacy vocals stem from the same process.
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

/** One failure must not abandon the rest. The source is deleted ONLY once the destination exists and is
 *  non-empty: losing a playable stem to a half-written encode is worse than keeping a large file. */
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
			// The ref still needs updating if a previous run already converted the file.
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
 * Least-recently-used first, until the derived total fits the cap. PURE. `protectedIds` is enforced HERE
 * rather than left to the caller, because a process stripped from under a live or queued entry vanishes
 * mid-party. Protected songs still COUNT toward the total, so an unreachable cap evicts everything it is
 * allowed to rather than under-reporting the pressure.
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
 * The ONE list `evictDerived`, `derivedBytesOf` and `media/delete.ts` all read. Omitting a category
 * undercounts the bytes AND orphans that file on disk forever, since eviction only frees what it can
 * name. A stored ref is authoritative; the id-derived keys are fallbacks for rows that never recorded
 * one, and a key whose file is absent is skipped below. Callers dedupe with a Set.
 */
export function derivedRefsOf(m: Media): string[] {
	return [
		m.instrumentalRef,
		m.lyricsRef,
		// candidateVocalsRefs covers old rows across every legacy extension.
		m.vocalsRef,
		...candidateVocalsRefs(m),
		// guideMixKey is the fallback for a row that never recorded one.
		m.guideMixRef,
		guideMixKey(m.id),
		// Every candidate's JSON, not just the chosen lyricsRef.
		...(m.lyricsCandidates ?? []).map((c) => c.ref),
		// Not stored as a ref: the worker writes a deterministic per-(kind,ext) path, so these are named
		// from the id instead.
		...CAPTION_KINDS.flatMap((kind) => KNOWN_CAPTION_EXTS.map((ext) => rawCaptionKey(m.id, kind, ext))),
		// A fetched song's kept original goes with its captions: both come back from the watch URL.
		m.source === 'local' ? undefined : m.originalRef
	].filter((r): r is string => !!r);
}

/** NEVER touches `meta/`, or `audio/` beyond a fetched song's kept original. `evictSong` resets the media to
 *  un-processed, so rotation stops treating it as playable. */
export function evictDerived(m: Media): { removed: string[]; bytes: number } {
	const removed: string[] = [];
	let bytes = 0;
	for (const ref of new Set(derivedRefsOf(m))) {
		const abs = safeMediaPath(ref);
		if (!abs || !existsSync(abs)) continue;
		try {
			const size = statSync(abs).size;
			// Counted only AFTER the delete succeeds, or a file still on disk reads as reclaimed.
			rmSync(abs, { force: true });
			bytes += size;
			removed.push(ref);
		} catch (err) {
			// Named, not swallowed, or a clean pass looks identical to one that failed silently.
			console.warn(`retention: failed to evict derived artifact ${ref}:`, err);
		}
	}
	return { removed, bytes };
}

/** What an evicted song's row forgets, so nothing names a file `evictDerived` just deleted and the next process
 *  reads a fetched song's watch URL again. The caller persists the row, then `clearArtifacts` the sidecar. */
export function forgetEvicted(m: Media, jobs: Pick<JobRepository, 'supersedeForRerun'>): void {
	forgetProcess(m, jobs);
	if (m.source !== 'local') {
		m.originalRef = undefined;
		m.originalBytes = undefined;
	}
}

/** One song's eviction: the files, then the DB row and the sidecar, so no screen still calls it made. */
export async function evictSong(
	m: Media,
	deps: { jobs: Pick<JobRepository, 'supersedeForRerun'>; upsert: (m: Media) => void }
): Promise<number> {
	const { bytes } = evictDerived(m);
	forgetEvicted(m, deps.jobs);
	deps.upsert(m);
	// upsert's sidecar merge would RESTORE the refs just cleared — see clearArtifacts.
	await clearArtifacts(m.id);
	return bytes;
}

/** MUST agree with evictDerived. */
export function derivedBytesOf(m: Media): number {
	let n = 0;
	for (const ref of new Set(derivedRefsOf(m))) {
		const abs = safeMediaPath(ref);
		if (!abs || !existsSync(abs)) continue;
		try {
			n += statSync(abs).size;
		} catch {
			// A file that vanished between the existence check and the stat contributes nothing, and this
			// runs per artifact per song on every boot — unlike `evictDerived`, a warning here would be noise.
		}
	}
	return n;
}

// 120s bounds a hung ffmpeg without tripping on a genuinely long track.
const TRANSCODE_TIMEOUT_MS = 120_000;

/**
 * Lossless stereo FLAC, matching the worker's `encode_flac_argv`, so a recompressed legacy stem lands in
 * the same codec a fresh process does — a legacy WAV is itself lossless, so this is no second lossy
 * generation. The encoder MUST be FLAC: AAC into a `.flac` container is a mismatch the muxer rejects.
 * Returns FALSE rather than throwing, so the caller keeps the larger-but-playable original.
 */
export function ffmpegTranscoder(ffmpegBin = process.env.FFMPEG_BIN ?? 'ffmpeg'): Transcoder {
	const base = ['-hide_banner', '-loglevel', 'error', '-y'];
	const encode = ['-c:a', 'flac', '-compression_level', '8', '-sample_fmt', 's16', '-ac', '2'];

	const run = async (argv: string[]): Promise<{ ok: boolean; err: string }> => {
		// Killed on timeout, or a hung ffmpeg on the detached boot chain stalls retention forever.
		const r = await runCapturing(argv, TRANSCODE_TIMEOUT_MS);
		if (r.timedOut) return { ok: false, err: `ffmpeg timed out after ${TRANSCODE_TIMEOUT_MS}ms` };
		return { ok: r.code === 0, err: r.stderr };
	};

	return async (absFrom, absTo) => {
		try {
			// FLAC has no moov atom, so no faststart flag applies.
			const r = await run([ffmpegBin, ...base, '-i', absFrom, ...encode, absTo]);
			if (!r.ok) transcodeDiagnostics.lastError = r.err.trim().split('\n')[0] ?? '';
			return r.ok;
		} catch (err) {
			transcodeDiagnostics.lastError = `could not run ${ffmpegBin}: ${(err as Error).message}`;
			return false; // ffmpeg absent — nothing to do but leave the file alone
		}
	};
}
