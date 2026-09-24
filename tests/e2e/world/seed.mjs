/*
 * THE demo library fixture, in ONE place.
 *
 * It used to be split in half with an admitted drift hazard: `server.ts` held the titles, artists and
 * durations, `seed-media.mjs` held the filenames, and seed-media.mjs said so outright — "Must match the
 * seededLibrary sourceRefs in server.ts. NOT covered by the contract guard — these are dev-seed data rather
 * than UI selectors, so nothing reds if they drift apart."
 *
 * Nothing seeds a real deployment any more. Core scans `MEDIA_DIR/library` (app.ts, the 'local library scan'
 * pass), so a demo catalog is a TEST fixture and lives here. See docs/E2E.md#the-demo-library.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tone } from '../wav.mjs';

/**
 * REAL, DECODABLE WAV — not the 16-byte ISO-BMFF stub this fixture wrote before.
 *
 * Two reasons it had to change. Core now reads a duration with ffmpeg before indexing a library file and
 * SKIPS one it cannot measure, so a 16-byte stub would index nothing at all. And an undecodable fixture never
 * proved playback in the first place — the old seeder's own header admitted the files were "NOT decodable
 * media — indexing/queueing only, never playback or processing".
 *
 * `seconds` is deliberately short: a real 4-minute track at 44.1 kHz mono s16 is 22 MB, and four of them is
 * ~90 MB of fixture. These are 8 s, so the catalog's wait estimates are fixture values, not real runtimes.
 * Each track gets its own chord so a human can tell by ear which one is playing.
 *
 * THE FILENAME IS THE ONLY METADATA. Core derives a library track's title and artist from the file name
 * (`trackNameFromFile`), so there is nothing here to declare a title with — a `title` field would be a value
 * nothing reads. The names stay kebab-case rather than the `Artist - Title.wav` form the scanner also
 * understands, because probes match on a stable substring (`sourceRef.includes('sweet-caroline')`).
 *
 * @type {{ file: string, seconds: number, hz: number[] }[]}
 */
export const DEMO_LIBRARY = [
	{ file: 'dont-stop-believin.wav', seconds: 8, hz: [220, 277.18, 329.63] },
	{ file: 'sweet-caroline.wav', seconds: 8, hz: [246.94, 311.13, 369.99] },
	{ file: 'bohemian-rhapsody.wav', seconds: 8, hz: [261.63, 329.63, 392.0] },
	{ file: 'livin-on-a-prayer.wav', seconds: 8, hz: [293.66, 369.99, 440.0] }
];

/** The refs core will mint for these files, for a probe that wants to assert on one without rebuilding the path. */
export const DEMO_SOURCE_REFS = DEMO_LIBRARY.map((t) => `library/${t.file}`);

/**
 * Write the fixture into `mediaDir/library`, skipping files already there. Returns how many were written.
 * @param {string} mediaDir
 */
export function seedDemoLibrary(mediaDir) {
	const dir = join(mediaDir, 'library');
	mkdirSync(dir, { recursive: true });
	let written = 0;
	for (const track of DEMO_LIBRARY) {
		const path = join(dir, track.file);
		if (existsSync(path)) continue;
		writeFileSync(path, tone({ seconds: track.seconds, hz: track.hz }));
		written++;
	}
	return { dir, written, total: DEMO_LIBRARY.length };
}
