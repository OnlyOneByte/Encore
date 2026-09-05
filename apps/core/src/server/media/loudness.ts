// Loudness probing — "does this audio file actually contain audio?"
//
// WHY THIS EXISTS: separation can succeed and still write digital silence. Two of the songs in the
// live library are exactly that — instrumental AND vocals at the 16-bit floor, 44-124KB against
// 14-28MB for a healthy cook. Every readiness check in the system verified that a ref EXISTED, never
// that the file behind it carried sound, so those songs sat in the Ready list and would have played
// four minutes of nothing.
//
// A guiding track makes that failure worse, not better: a silent vocals stem is indistinguishable
// from a working one until the singer turns the control up and nothing happens. So the ref is only
// set for a stem that measurably has content.
//
// Split pure/IO like the rest of media/: the parser and the verdict are pure and unit-tested, and
// only the spawn wrapper touches ffmpeg.

/** What `ffmpeg -af volumedetect` reports about a file, in dBFS (both values are ≤ 0). */
export interface LoudnessReading {
	meanDb: number;
	maxDb: number;
}

/**
 * Peak at or below this is digital silence. 16-bit silence measures ≈ -91 dBFS, and no real vocal
 * stem peaks anywhere near it — a quiet one still hits -30 or so. -90 leaves headroom for a
 * dithered "silent" file without ever catching genuine audio.
 */
export const SILENCE_FLOOR_DB = -90;

/**
 * PURE: pull mean/max volume out of ffmpeg's volumedetect output. Returns null when the lines are
 * absent (wrong filter, ffmpeg error, truncated output) — null means "could not measure", which is
 * deliberately NOT the same as "measured silence".
 */
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
 * PURE: is this reading digital silence?
 *
 * An UNMEASURABLE file (null) is NOT silence. That distinction is the whole safety property here: if
 * ffmpeg is missing or refuses the file, refusing every guiding track in the library would be a
 * self-inflicted outage, so an unknown reading is treated as audible and we trust whatever produced
 * the stem. We only ever act on a positive measurement of silence.
 */
export function isDigitalSilence(reading: LoudnessReading | null): boolean {
	if (!reading) return false;
	return reading.maxDb <= SILENCE_FLOOR_DB;
}

export type LoudnessProbe = (absPath: string) => Promise<LoudnessReading | null>;

/**
 * ffmpeg-backed probe. Decodes to null output purely to collect volumedetect's summary, so it reads
 * the whole file but writes nothing.
 *
 * Returns null rather than throwing when ffmpeg is absent or errors — see `isDigitalSilence` for why
 * "could not measure" must stay distinguishable from "silent".
 */
export function ffmpegLoudnessProbe(ffmpegBin = process.env.FFMPEG_BIN ?? 'ffmpeg'): LoudnessProbe {
	return async (absPath) => {
		try {
			const proc = Bun.spawn(
				[ffmpegBin, '-hide_banner', '-nostats', '-i', absPath, '-af', 'volumedetect', '-f', 'null', '-'],
				{ stdout: 'ignore', stderr: 'pipe' }
			);
			// volumedetect prints its summary to stderr at the END of the decode, so the text is only
			// complete once the process has exited.
			const [, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
			return parseVolumeDetect(stderr);
		} catch {
			return null; // ffmpeg absent — unmeasurable, not silent
		}
	};
}
