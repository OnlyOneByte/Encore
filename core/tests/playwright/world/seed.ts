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

/** Each made song's derived files, 64 bytes each. */
export const MADE_SONG_FILES = [
	'instrumental.flac',
	'vocals.flac',
	'guidemix.flac',
	'c0.json',
	'c1.json',
	'c2.json',
	'edit-r1.json'
];

/** `count` songs that are already made: a sidecar in `mediaDir/meta` each, which the boot restore indexes, and its
 *  stems and lyrics files. Must run BEFORE core boots, like the library. */
export function seedMadeLibrary(mediaDir: string, count: number): void {
	for (const d of ['meta', 'derived/stems', 'derived/lyrics']) mkdirSync(join(mediaDir, d), { recursive: true });
	for (let i = 0; i < count; i++) {
		const id = `01MADE${String(i).padStart(8, '0')}`;
		const ref = (file: string) => `derived/${file.endsWith('.json') ? 'lyrics' : 'stems'}/${id}-${file}`;
		for (const f of MADE_SONG_FILES) writeFileSync(join(mediaDir, ref(f)), 'x'.repeat(64));
		const sidecar = {
			id,
			schema: 7,
			origin: { source: 'youtube', sourceRef: `made${i}`, fetchedAt: 1_700_000_000_000 },
			canonical: {
				mbid: null,
				artist: 'Made',
				artistCredit: null,
				title: `Song ${i}`,
				album: null,
				year: null,
				genre: [],
				language: null,
				durationSec: 180
			},
			provenance: {},
			artifacts: {
				audio: null,
				instrumental: ref('instrumental.flac'),
				vocals: ref('vocals.flac'),
				guideMix: ref('guidemix.flac'),
				lyrics: ref('c0.json'),
				lyricsCandidates: ['c0', 'c1', 'c2'].map((c) => ({ ref: ref(`${c}.json`), textSource: 'lrclib' }))
			},
			library: { tags: [], addedAt: 1_700_000_000_000 + i, playCount: 0, lastPlayedAt: null },
			raw: { uploader: 'Made', rawTitle: `Made - Song ${i}`, thumbnail: null }
		};
		writeFileSync(join(mediaDir, 'meta', `${id}.json`), JSON.stringify(sidecar));
	}
}

/** YouTube songs nobody has made yet, one sidecar each with no artifacts, so picking one runs a FETCH first, as
 *  a song found on YouTube does, with no live resolver. Must run BEFORE core boots, like the library. */
export function seedYoutubeSongs(mediaDir: string, titles: string[]): void {
	mkdirSync(join(mediaDir, 'meta'), { recursive: true });
	titles.forEach((title, i) => {
		const id = `01YTUB${String(i).padStart(8, '0')}`;
		const sidecar = {
			id,
			schema: 7,
			origin: { source: 'youtube', sourceRef: `yt-${i}`, fetchedAt: 1_700_000_000_000 },
			canonical: {
				mbid: null,
				artist: 'Tube',
				artistCredit: null,
				title,
				album: null,
				year: null,
				genre: [],
				language: null,
				durationSec: 8
			},
			provenance: {},
			artifacts: {
				audio: null,
				instrumental: null,
				vocals: null,
				guideMix: null,
				lyrics: null,
				lyricsCandidates: []
			},
			library: { tags: [], addedAt: 1_700_000_000_000 + i, playCount: 0, lastPlayedAt: null },
			raw: { uploader: 'Tube', rawTitle: `Tube - ${title}`, thumbnail: null }
		};
		writeFileSync(join(mediaDir, 'meta', `${id}.json`), JSON.stringify(sidecar));
	});
}
