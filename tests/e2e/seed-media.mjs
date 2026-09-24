/*
 * Seed the four demo library tracks, as PLACEHOLDERS — see docs/E2E.md#proving-audio. server.ts indexes a
 * demo track only when a file exists behind it, so an unseeded checkout can queue nothing.
 *
 *   MEDIA_DIR=/tmp/x bun run tests/e2e/seed-media.mjs      # default ./media
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MEDIA = process.env.MEDIA_DIR ?? './media';
const dir = join(MEDIA, 'library');

// Must match the seededLibrary sourceRefs in server.ts. NOT covered by the contract guard — these are
// dev-seed data rather than UI selectors, so nothing reds if they drift apart.
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
