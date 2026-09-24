/*
 * Seed the demo library into MEDIA_DIR/library. The fixture itself — filenames, titles, artists, tone — lives
 * in world/seed.mjs, which is the whole point: it used to be half here and half in server.ts, with this file's
 * own header warning that nothing would notice if the two drifted apart.
 *
 *   MEDIA_DIR=/tmp/x bun run tests/e2e/seed-media.mjs      # default ./media
 */
import { seedDemoLibrary } from './world/seed.mjs';

const { dir, written, total } = seedDemoLibrary(process.env.MEDIA_DIR ?? './media');

console.log(`seeded ${written} track(s) into ${dir} (${total} total)`);
// Core reads a duration with ffmpeg before indexing a library file and skips any file it cannot measure, so
// these are real decodable WAV rather than the 16-byte mp4 stubs this script used to write. They are 8 seconds
// each, so every duration the UI shows for them is a fixture value.
console.log('real 8s WAV tones — decodable and playable, but their durations are fixture values, not runtimes');
