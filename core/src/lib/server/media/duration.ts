// "How long is this file?" A library scan finds filenames, and no filename says how long a song runs — but
// `LocalTrack.durationSec` feeds the queue's wait estimate. So it is MEASURED, never defaulted: this repo
// omits an unknown estimate rather than zeroing it (see `waitWords`), and a 0 here would read as a
// zero-length song rather than as an unknown one. A file whose length cannot be read is not indexed at all.

import { runCapturing } from './spawn-capture';

/** PURE. Null means "could not read a duration", which is NOT the same as "zero seconds". */
export function parseFfmpegDuration(stderr: string): number | null {
	// ffmpeg prints `  Duration: 00:03:33.76, start: 0.000000, bitrate: 127 kb/s` for every input it opens.
	// A stream of unknown length prints `Duration: N/A`, which this pattern declines rather than reading as 0.
	const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
	if (!m) return null;
	const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
	// A container can report 00:00:00.00 for a file it opened but cannot measure; that is unknown, not empty.
	if (!Number.isFinite(seconds) || seconds <= 0) return null;
	return Math.round(seconds);
}

export type DurationProbe = (absPath: string) => Promise<number | null>;

// Opens the container and decodes nothing, so the cost is one file open rather than a full decode.
const PROBE_TIMEOUT_MS = 15_000;

/** Returns null rather than throwing when ffmpeg is absent, so a missing binary indexes nothing instead of
 *  indexing every song as zero-length. */
export function ffmpegDurationProbe(ffmpegBin = process.env.FFMPEG_BIN ?? 'ffmpeg'): DurationProbe {
	return async (absPath) => {
		try {
			// `-t 0` writes no output; the header line we want is on stderr either way.
			const r = await runCapturing(
				[ffmpegBin, '-hide_banner', '-i', absPath, '-t', '0', '-f', 'null', '-'],
				PROBE_TIMEOUT_MS
			);
			if (r.timedOut) return null;
			return parseFfmpegDuration(r.stderr);
		} catch {
			return null;
		}
	};
}
