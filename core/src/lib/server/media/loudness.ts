// "Does this file actually contain audio?" Separation can SUCCEED and still write digital silence, and
// readiness otherwise only checks that a ref EXISTS — so a silent stem is indistinguishable from a working
// one until the singer turns the control up. A ref is therefore only set for a stem that measurably has content.

import { runCapturing } from './spawn-capture';

/** What `ffmpeg -af volumedetect` reports about a file, in dBFS (both values are ≤ 0). */
export interface LoudnessReading {
	meanDb: number;
	maxDb: number;
}

// 16-bit silence measures about -91 dBFS while even a quiet vocal stem hits -30, so -90 leaves headroom
// without ever catching genuine audio.
export const SILENCE_FLOOR_DB = -90;

/** PURE. Null means "could not measure", deliberately NOT the same as "measured silence". */
export function parseVolumeDetect(stderr: string): LoudnessReading | null {
	const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr);
	const max = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr);
	if (!mean || !max) return null;
	const meanDb = Number(mean[1]);
	const maxDb = Number(max[1]);
	if (!Number.isFinite(meanDb) || !Number.isFinite(maxDb)) return null;
	return { meanDb, maxDb };
}

/** An UNMEASURABLE file is NOT silence: treating "unknown" as silent refuses every guiding track the moment
 *  ffmpeg is missing, a self-inflicted outage. Only a POSITIVE measurement acts. */
export function isDigitalSilence(reading: LoudnessReading | null): boolean {
	if (!reading) return false;
	return reading.maxDb <= SILENCE_FLOOR_DB;
}

export type LoudnessProbe = (absPath: string) => Promise<LoudnessReading | null>;

const PROBE_TIMEOUT_MS = 60_000; // decodes the whole file; generous headroom that still bounds a hang

/** Decodes to null output purely to collect volumedetect's summary. Returns null rather than throwing when
 *  ffmpeg is absent, which MUST stay distinguishable from "silent". */
export function ffmpegLoudnessProbe(ffmpegBin = process.env.FFMPEG_BIN ?? 'ffmpeg'): LoudnessProbe {
	return async (absPath) => {
		try {
			// The summary is only complete once the process exits.
			const r = await runCapturing(
				[ffmpegBin, '-hide_banner', '-nostats', '-i', absPath, '-af', 'volumedetect', '-f', 'null', '-'],
				PROBE_TIMEOUT_MS
			);
			if (r.timedOut) return null; // hung/killed — cannot judge, do not pretend to
			return parseVolumeDetect(r.stderr);
		} catch {
			return null; // ffmpeg absent — unmeasurable, not silent
		}
	};
}
