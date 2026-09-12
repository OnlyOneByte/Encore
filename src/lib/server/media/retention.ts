// Retention — keep the volume bounded without ever losing something unrecoverable.
//
// Two jobs, separated because they have different costs:
//   1. RECOMPRESS legacy formats. Songs processed before the current audio policy have WAV stems, ~8x
//      larger than today's FLAC. Transcoded IN PLACE (bytes already on disk, no download, no Demucs
//      run, song never leaves the library) — the right tool for reclaiming pre-policy space, not
//      eviction.
//   2. EVICT derived artifacts when over a soft cap. Derived data is regenerable from `audio/`, so
//      dropping it costs a re-process (1-2 min) and nothing permanent. `audio/` and `meta/` are NEVER
//      touched: audio cannot be re-acquired once an upload disappears, and meta IS the library.
//
// The planning half is pure so the policy is testable without a filesystem or a transcoder.

import { existsSync, statSync, rmSync } from 'node:fs';
import type { Media } from '$lib/contract';
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

// ── legacy-format recompression ─────────────────────────────────────────────────────

/**
 * A stem ref worth transcoding: an UNCOMPRESSED (WAV) artifact from before the audio policy.
 *
 * Deliberately NOT "anything not the current format": both stems now target FLAC, so that
 * looser rule would flag every existing `.m4a` vocals stem for "upgrade", and AAC→FLAC is actively
 * harmful — it cannot recover what the lossy encode discarded, only produce a ~4x larger file of the
 * same audio. Legacy `.m4a` processes therefore keep their `.m4a` and are NOT recompressed; only WAV
 * (a genuinely uncompressed pre-policy artifact) is worth transcoding, and a real codec upgrade means
 * re-processing from the retained raw audio, a different operation.
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

/**
 * Which artifacts of these media are on a legacy format. PURE — takes the catalog, returns work.
 *
 * The vocals ref is not stored on Media (only the worker writes it), so it is derived from the key
 * convention and existence-checked by the caller.
 */
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

/**
 * Transcode legacy stems in place. Each conversion is isolated: one failure must not abandon the rest,
 * and the source is only deleted once the destination exists and is non-empty — losing a playable
 * instrumental to a half-written encode would be far worse than keeping a large file.
 */
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

// ── cap-based eviction ──────────────────────────────────────────────────────────────

export interface EvictionCandidate {
	mediaId: string;
	/** Total bytes this song's DERIVED artifacts occupy. */
	derivedBytes: number;
	/** Recency signal — lastPlayedAt when known, else addedAt. Lower is evicted first. */
	lastUsedAt: number;
}

/**
 * Which songs to strip back to un-processed, least-recently-used first, until the derived total fits the
 * cap. PURE.
 *
 * `protectedIds` names media that must NEVER be evicted regardless of age — the currently-playing song
 * and everything queued. A process stripped out from under a live or queued entry would vanish mid-party
 * (stemStatus reset to 'none', derived stems gone, an entry pointing at a media that can no longer
 * play). Enforcing the exclusion HERE, in the pure function, means the guarantee holds no matter what
 * a caller remembers to filter — the previous design left it to the caller and the caller did not.
 * Protected songs still count toward the total (they occupy real bytes), so the plan can conclude the
 * cap is unreachable and evict everything it is allowed to rather than under-reporting the pressure.
 *
 * Recency signal: play tracking IS wired — `plays.ts` bumps `library.lastPlayedAt` and the caller reads
 * it in preference to `addedAt`, so this is least-recently-PLAYED, falling back to oldest-added only for
 * songs that have never played.
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
 * Every `derived/` ref a song could have on disk — the ONE list both the eviction and the plan read.
 *
 * They used to build this inline and had drifted: the plan omitted `vocalsKey`, so a modern process's
 * vocals stem was deleted by `evictDerived` but invisible to `derivedBytesOf`. It read as correct
 * because the ext-blind `-instrumental.`→`-vocals.` swap only resolves when the two stems share an
 * extension, and `vocalsKey` derives from the CURRENT `VOCALS_EXT`. Neither can name a stem whose
 * stored extension differs from today's constant — e.g. an interim process (instrumental `.flac`, vocals
 * `.m4a`) after an earlier change flipped `VOCALS_EXT` to `.flac`. So the authoritative source is `m.vocalsRef`,
 * the ref each process actually stored; it covers legacy `.wav`, interim `.m4a`, and current `.flac`
 * alike. `planEviction` compares the SUM against the cap, so undercounting made retention conclude
 * there was nothing to reclaim on a volume genuinely over budget. Anything derived that a song can own
 * belongs here, not in a caller.
 *
 * `m.vocalsRef` is authoritative when present; `vocalsKey` + the ext-blind swap are the fallback for
 * old rows that never stored a vocals ref.
 *
 * `lyricsRef` is only the CHOSEN candidate's JSON; a song can carry several lyrics artifacts (one per
 * text source — see `lyricsCandidates` in shared/types.ts and the distinct per-candidate keys minted
 * at worker `lyrics/chain.py`). Listing `lyricsRef` alone counted 1 of N and left the other N−1 lyrics
 * JSONs both uncounted and, worse, permanently orphaned on disk when the song was evicted. Enumerate
 * every candidate ref too — same class of drift the vocals-omission fix above closed.
 *
 * Callers dedupe with a Set, so overlap (a candidate that equals `lyricsRef`) is free.
 *
 * Exported because `media/delete.ts` needs the same answer: it had grown a SECOND enumeration
 * (`derivedRefsFor`) that omitted `lyricsCandidates`, re-creating the exact undercount two earlier changes closed
 * here — N−1 lyrics JSONs orphaned forever, since a hard delete removes the sidecar and the row and
 * nothing can ever enumerate that media again. Two hand-maintained answers to "what does this media own
 * on disk" is the defect; this is the one answer. The delete adds id-derived keys on top (it must name
 * refs a media never stored), it does not maintain a rival list.
 */
export function derivedRefsOf(m: Media): string[] {
	return [
		m.instrumentalRef,
		m.lyricsRef,
		// The STORED per-media vocals ref is authoritative and covers ALL layouts regardless of what
		// VOCALS_EXT currently is: legacy.wav, interim.m4a, and current.flac processes all recorded a ref.
		// vocalsKey + the ext-blind swap are the FALLBACK for old rows that never stored one. Without
		// m.vocalsRef, flipping VOCALS_EXT to.flac would strand the already-processed.m4a vocals
		// cohort — the cohort this PR deliberately does not recompress — from both byte-counting and
		// eviction, so derivedBytesOf would undercount and evictDerived would orphan those files.
		// candidateVocalsRefs is the SINGLE candidate list (vocalsKey + every legacy-ext sibling);
		// m.vocalsRef is prepended because it is authoritative when the worker stored one.
		m.vocalsRef,
		...candidateVocalsRefs(m),
		// The GUIDE MIX (both stems in one 4-channel file). Same rule as the vocals stem, and the same
		// undercount if omitted: it is `derived/`, it is the LARGEST single stem artifact a song owns
		// (roughly the two stems combined), and eviction would orphan it on disk forever while
		// derivedBytesOf reported a volume smaller than it is. The stored ref is authoritative; the
		// id-derived key is the fallback for a row whose mix exists but was never recorded — a key whose
		// file is absent is skipped by the existsSync check below, so naming both is free.
		m.guideMixRef,
		guideMixKey(m.id),
		// Every lyrics candidate's JSON, not just the chosen one (`lyricsRef`). Each source mints a
		// distinct key, so the others are silently orphaned on eviction unless enumerated here.
		...(m.lyricsCandidates ?? []).map((c) => c.ref),
		// The retained RAW caption track. It is NOT stored as a ref on Media — the worker copies it
		// to a deterministic per-media path (derived/captions/<kind>/<id>.captions.<ext>) gated on
		// ENCORE_KEEP_RAW_CAPTIONS — so it is enumerated from the id, one key per (kind, ext). Without this
		// it inherits NONE of the "safe to delete, first to evict" retention its own docstring claims:
		// derivedBytesOf undercounts and evictDerived orphans the file on disk permanently, the identical
		// undercount two earlier changes closed for the vocals/lyrics siblings above. Naming both exts per kind is
		// free: the ext is chosen from the winning file at process time (.vtt/.srt), and a key whose file is
		// absent is skipped by the existsSync check below. Callers dedupe with a Set.
		...CAPTION_KINDS.flatMap((kind) => KNOWN_CAPTION_EXTS.map((ext) => rawCaptionKey(m.id, kind, ext)))
	].filter((r): r is string => !!r);
}

/**
 * Delete a song's derived artifacts and return the refs that were removed. The caller resets the media
 * to un-processed so rotation stops treating it as playable and a re-request re-processes it.
 * NEVER touches `audio/` or `meta/`.
 */
export function evictDerived(m: Media): { removed: string[]; bytes: number } {
	const removed: string[] = [];
	let bytes = 0;
	for (const ref of new Set(derivedRefsOf(m))) {
		const abs = safeMediaPath(ref);
		if (!abs || !existsSync(abs)) continue;
		try {
			const size = statSync(abs).size;
			// Count bytes only AFTER the delete succeeds. rmSync can throw (force suppresses ENOENT
			// only — EACCES/EPERM/EROFS/EBUSY still throw), and counting first reported bytes freed for
			// a file still on disk, so `removed` and `bytes` disagreed silently and the operator was
			// told over-budget bytes were reclaimed that were not.
			rmSync(abs, { force: true });
			bytes += size;
			removed.push(ref);
		} catch (err) {
			// A file we cannot remove is not worth failing the pass over, but it must be diagnosable:
			// the bare catch discarded which file failed and why, so a clean pass looked like one that
			// freed nothing.
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

// A legacy-stem recompress transcodes one file; a few seconds when healthy. 120s bounds a hung
// ffmpeg without tripping on a genuinely long track.
const TRANSCODE_TIMEOUT_MS = 120_000;

/**
 * ffmpeg-backed transcoder: lossless stereo FLAC, matching the worker's `encode_flac_argv`, so
 * a recompressed legacy stem lands in the SAME codec and container a freshly processed one does. The
 * destination is a `.flac` ref (INSTRUMENTAL_EXT/VOCALS_EXT, paths.ts), and a legacy WAV stem is
 * itself lossless — FLAC recompresses it without a second lossy generation, exactly what the FLAC
 * policy protects (a native-ffmpeg AAC re-encode would smear the crash-cymbal transients this stem
 * carries; see paths.ts and worker processor.py). AAC into a `.flac` container is a codec/container
 * mismatch the FLAC muxer rejects, so the encoder MUST be FLAC to match the name.
 *
 * Returns false (not throws) when ffmpeg is absent or genuinely fails, so the caller keeps the
 * larger-but-playable original.
 */
export function ffmpegTranscoder(ffmpegBin = process.env.FFMPEG_BIN ?? 'ffmpeg'): Transcoder {
	const base = ['-hide_banner', '-loglevel', 'error', '-y'];
	const encode = ['-c:a', 'flac', '-compression_level', '8', '-sample_fmt', 's16', '-ac', '2'];

	const run = async (argv: string[]): Promise<{ ok: boolean; err: string }> => {
		// Killed after TRANSCODE_TIMEOUT_MS: the recompress pass runs on the DETACHED boot chain, so a
		// hung ffmpeg would stall retention (and, before per-pass isolation, everything after it) forever.
		const r = await runCapturing(argv, TRANSCODE_TIMEOUT_MS);
		if (r.timedOut) return { ok: false, err: `ffmpeg timed out after ${TRANSCODE_TIMEOUT_MS}ms` };
		return { ok: r.code === 0, err: r.stderr };
	};

	return async (absFrom, absTo) => {
		try {
			// FLAC has no moov atom, so the MP4-era `-movflags +faststart` (and its "unrecognized
			// option" degrade path) is gone with the AAC encoder — a single FLAC encode into the .flac
			// destination is the whole operation.
			const r = await run([ffmpegBin, ...base, '-i', absFrom, ...encode, absTo]);
			if (!r.ok) transcodeDiagnostics.lastError = r.err.trim().split('\n')[0] ?? '';
			return r.ok;
		} catch (err) {
			transcodeDiagnostics.lastError = `could not run ${ffmpegBin}: ${(err as Error).message}`;
			return false; // ffmpeg absent — nothing to do but leave the file alone
		}
	};
}
