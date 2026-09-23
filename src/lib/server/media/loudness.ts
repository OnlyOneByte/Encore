// Loudness probing: "does this audio file actually contain audio?" Separation can succeed and still
// write digital silence, and readiness otherwise only checks that a ref EXISTS, not that it carries
// sound — a silent stem is indistinguishable from a working one until the singer turns the control up
// and nothing happens. A ref is therefore only set for a stem that measurably has content.

import { runCapturing } from './spawn-capture';

/** What `ffmpeg -af volumedetect` reports about a file, in dBFS (both values are ≤ 0). */
export interface LoudnessReading {
	meanDb: number;
	maxDb: number;
}

// Peak at or below this is digital silence: 16-bit silence measures ≈ -91 dBFS while even a quiet
// vocal stem hits -30 or so, so -90 leaves headroom without ever catching genuine audio.
export const SILENCE_FLOOR_DB = -90;

/** PURE: pull mean/max volume out of ffmpeg's volumedetect output. Null means "could not measure" —
 *  deliberately NOT the same as "measured silence". */
export function parseVolumeDetect(stderr: string): LoudnessReading | null {
	const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr);
	const max = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr);
	if (!mean || !max) return null;
	const meanDb = Number(mean[1]);
	const maxDb = Number(max[1]);
	if (!Number.isFinite(meanDb) || !Number.isFinite(maxDb)) return null;
	return { meanDb, maxDb };
}

/**
 * PURE: is this reading digital silence? An UNMEASURABLE file (null) is NOT silence — treating
 * "unknown" as silent would refuse every guiding track the moment ffmpeg is missing or errors, a
 * self-inflicted outage. Only a positive measurement of silence acts.
 */
export function isDigitalSilence(reading: LoudnessReading | null): boolean {
	if (!reading) return false;
	return reading.maxDb <= SILENCE_FLOOR_DB;
}

export type LoudnessProbe = (absPath: string) => Promise<LoudnessReading | null>;

const PROBE_TIMEOUT_MS = 60_000; // decodes the whole file; generous headroom that still bounds a hang

/**
 * ffmpeg-backed probe: decodes to null output purely to collect volumedetect's summary. Returns null
 * rather than throwing when ffmpeg is absent or errors — see `isDigitalSilence` for why that must
 * stay distinguishable from "silent".
 */
export function ffmpegLoudnessProbe(ffmpegBin = process.env.FFMPEG_BIN ?? 'ffmpeg'): LoudnessProbe {
	return async (absPath) => {
		try {
			// volumedetect's summary is only complete once the process exits.
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
