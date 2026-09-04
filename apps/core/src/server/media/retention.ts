// Retention — keep the volume bounded without ever losing something unrecoverable.
//
// Two jobs, separated because they have different costs:
//   1. RECOMPRESS legacy formats. Songs cooked before the current audio policy have WAV stems, ~8x
//      larger than today's AAC. Transcoded IN PLACE (bytes already on disk, no download, no Demucs
//      run, song never leaves the library) — the right tool for reclaiming pre-policy space, not
//      eviction.
//   2. EVICT derived artifacts when over a soft cap. Derived data is regenerable from `audio/`, so
//      dropping it costs a re-cook (1-2 min) and nothing permanent. `audio/` and `meta/` are NEVER
//      touched: audio cannot be re-acquired once an upload disappears, and meta IS the library.
//
// The planning half is pure so the policy is testable without a filesystem or a transcoder.

import { existsSync, statSync, rmSync } from 'node:fs';
import type { Media } from '@encore/shared';
import { safeMediaPath } from './local-files';
import { instrumentalKey, vocalsKey, STEM_EXT } from './paths';

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
 * Deliberately NOT "anything not the current format": when the instrumental target became FLAC that
 * looser rule would flag every existing `.m4a` for "upgrade", and AAC→FLAC is actively harmful — it
 * cannot recover what the lossy encode discarded, only produce a ~4x larger file of the same audio. A
 * genuine codec upgrade means re-cooking from the retained raw audio, a different operation.
 */
export function isLegacyStemRef(ref: string | undefined | null): boolean {
	if (!ref) return false;
	return ref.endsWith('.wav');
}

export interface RecompressTarget {
	mediaId: string;
	/** The existing (legacy) ref, e.g. derived/stems/<id>-instrumental.wav */
	from: string;
	/** The ref it becomes, e.g. derived/stems/<id>-instrumental.m4a */
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
			// a legacy instrumental implies a legacy vocals stem from the same cook
			out.push({ mediaId: m.id, from: m.instrumentalRef!.replace('-instrumental.', '-vocals.'), to: vocalsKey(m.id), kind: 'vocals' });
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
export async function recompressLegacyStems(targets: RecompressTarget[], transcode: Transcoder): Promise<RecompressResult> {
	const res: RecompressResult = { converted: 0, bytesBefore: 0, bytesAfter: 0, skipped: 0, failed: 0, newRefs: new Map() };

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
		let ok = false;
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
 * Which songs to strip back to un-cooked, least-recently-used first, until the derived total fits the
 * cap. PURE.
 *
 * Recency signal caveat: play tracking is not wired yet (`library.lastPlayedAt` is never incremented),
 * so callers pass `addedAt` — making this oldest-added-first, not truly least-recently-played. Worth
 * upgrading once plays are counted.
 */
export function planEviction(candidates: EvictionCandidate[], capBytes: number | null): string[] {
	if (capBytes === null) return [];
	const total = candidates.reduce((n, c) => n + c.derivedBytes, 0);
	if (total <= capBytes) return [];

	const byAge = [...candidates].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
	const evict: string[] = [];
	let running = total;
	for (const c of byAge) {
		if (running <= capBytes) break;
		if (c.derivedBytes === 0) continue; // nothing to reclaim
		evict.push(c.mediaId);
		running -= c.derivedBytes;
	}
	return evict;
}

/**
 * Delete a song's derived artifacts and return the refs that were removed. The caller resets the media
 * to un-cooked so rotation stops treating it as playable and a re-request re-cooks it.
 * NEVER touches `audio/` or `meta/`.
 */
export function evictDerived(m: Media): { removed: string[]; bytes: number } {
	const removed: string[] = [];
	let bytes = 0;
	const refs = [m.instrumentalRef, m.lyricsRef, vocalsKey(m.id), m.instrumentalRef?.replace('-instrumental.', '-vocals.')].filter(
		(r): r is string => !!r
	);
	for (const ref of new Set(refs)) {
		const abs = safeMediaPath(ref);
		if (!abs || !existsSync(abs)) continue;
		try {
			bytes += statSync(abs).size;
			rmSync(abs, { force: true });
			removed.push(ref);
		} catch {
			/* a file we cannot remove is not worth failing the pass over */
		}
	}
	return { removed, bytes };
}

/** Total bytes of a song's derived artifacts, for the eviction plan. */
export function derivedBytesOf(m: Media): number {
	const refs = [m.instrumentalRef, m.lyricsRef, m.instrumentalRef?.replace('-instrumental.', '-vocals.')].filter(
		(r): r is string => !!r
	);
	let n = 0;
	for (const ref of new Set(refs)) {
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

/**
 * ffmpeg-backed transcoder: stereo AAC at the same bitrate the worker uses, so a recompressed legacy
 * stem is indistinguishable from a freshly cooked one.
 *
 * `-movflags +faststart` (moov atom first, so a browser can play before full download) is attempted
 * but NOT required: the host ffmpeg can be leaner than the worker container's, and one was — it
 * rejected the flag with "Unrecognized option 'movflags'", failing all 12 conversions. So a rejected
 * flag degrades to a plain encode rather than abandoning the file.
 *
 * Returns false (not throws) when ffmpeg is absent or genuinely fails, so the caller keeps the
 * larger-but-playable original.
 */
export function ffmpegTranscoder(ffmpegBin = process.env.FFMPEG_BIN ?? 'ffmpeg'): Transcoder {
	const base = ['-hide_banner', '-loglevel', 'error', '-y'];
	const encode = ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'];

	const run = async (argv: string[]): Promise<{ ok: boolean; err: string }> => {
		const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'pipe' });
		const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		return { ok: code === 0, err };
	};

	return async (absFrom, absTo) => {
		try {
			const withFast = await run([ffmpegBin, ...base, '-i', absFrom, ...encode, '-movflags', '+faststart', absTo]);
			if (withFast.ok) return true;
			// Only retry for an option the build does not know — a real encode error must not be masked.
			if (!/unrecognized option|option not found/i.test(withFast.err)) {
				transcodeDiagnostics.lastError = withFast.err.trim().split('\n')[0] ?? '';
				return false;
			}
			const plain = await run([ffmpegBin, ...base, '-i', absFrom, ...encode, absTo]);
			if (!plain.ok) transcodeDiagnostics.lastError = plain.err.trim().split('\n')[0] ?? '';
			return plain.ok;
		} catch (err) {
			transcodeDiagnostics.lastError = `could not run ${ffmpegBin}: ${(err as Error).message}`;
			return false; // ffmpeg absent — nothing to do but leave the file alone
		}
	};
}
