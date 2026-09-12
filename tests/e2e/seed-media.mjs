/*
 * Seed the four demo library tracks so the e2e can exercise the queue path.
 *
 *   bun run e2e/seed-media.mjs            # into ./media
 *   MEDIA_DIR=/tmp/x bun run e2e/seed-media.mjs
 *
 * WHY THIS IS NEEDED. server.ts indexes a demo track only when a file actually exists behind it. That
 * filter is deliberate and load-bearing: without it the four demos were searchable, queueable songs
 * that could never play, and processing one burned three worker attempts on `ffmpeg exited 254` before
 * leaving the song stuck in the phone's processing list for the rest of the night. So an unseeded
 * checkout has an empty library, and the e2e cannot queue anything.
 *
 * The files written here are PLACEHOLDERS, not media. They are enough for indexing, searching, queueing
 * and rotation — everything the flow asserts. They are NOT enough to decode, so do not use this to test
 * playback or processing; that needs real audio.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MEDIA = process.env.MEDIA_DIR ?? './media';
const dir = join(MEDIA, 'library');

// Must match the seededLibrary sourceRefs in server.ts. The contract guard does not cover these
// because they are dev-seed data rather than a UI selector, so they are listed with that warning.
const FILES = ['dont-stop-believin.mp4', 'sweet-caroline.mp4', 'bohemian-rhapsody.mp4', 'livin-on-a-prayer.mp4'];

mkdirSync(dir, { recursive: true });
let written = 0;
for (const f of FILES) {
	const p = join(dir, f);
	if (existsSync(p)) continue;
	// A minimal ISO-BMFF header, so anything sniffing the file sees an mp4 shape rather than a text file.
	writeFileSync(p, Buffer.from('00000018667479706d70343200000000', 'hex'));
	written++;
}
console.log(`seeded ${written} placeholder track(s) into ${dir} (${FILES.length} total)`);
console.log('these are NOT decodable media — indexing/queueing only, never playback or processing');
