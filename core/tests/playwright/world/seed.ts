// THE demo library fixture. Core scans MEDIA_DIR/library on boot and derives a track's title and artist from
// its FILENAME, so the filename is the only metadata here — a `title` field would be a value nothing reads.
//
// These are real 8-second WAV tones, not the 16-byte ISO-BMFF stubs the old fixture wrote. That is no longer
// optional: core reads a duration with ffmpeg before indexing a library file and SKIPS any file it cannot
// measure, because a track indexed at durationSec 0 is one the wait estimate reports as instant. Their 8
// seconds is therefore a fixture value, not a runtime.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tone } from './audio';

export interface DemoTrack {
	file: string;
	seconds: number;
	hz: number[];
}

/** Kebab-case on purpose: a spec matches a stable substring (`sourceRef.includes('sweet-caroline')`). The
 *  scanner also understands `Artist - Title.wav`, which `library-scan.test.ts` covers directly. */
export const DEMO_LIBRARY: DemoTrack[] = [
	{ file: 'dont-stop-believin.wav', seconds: 8, hz: [220, 277.18, 329.63] },
	{ file: 'sweet-caroline.wav', seconds: 8, hz: [246.94, 311.13, 369.99] },
	{ file: 'bohemian-rhapsody.wav', seconds: 8, hz: [261.63, 329.63, 392.0] },
	{ file: 'livin-on-a-prayer.wav', seconds: 8, hz: [293.66, 369.99, 440.0] }
];

/** Write the fixture into `mediaDir/library`. Must run BEFORE core boots — the scan is a boot pass. */
export function seedDemoLibrary(
	mediaDir: string,
	tracks: DemoTrack[] = DEMO_LIBRARY
): { dir: string; written: number; total: number } {
	const dir = join(mediaDir, 'library');
	mkdirSync(dir, { recursive: true });
	let written = 0;
	for (const track of tracks) {
		const path = join(dir, track.file);
		if (existsSync(path)) continue;
		writeFileSync(path, tone({ seconds: track.seconds, hz: track.hz }));
		written++;
	}
	return { dir, written, total: tracks.length };
}
