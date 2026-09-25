// Local library resolver — scans a media directory and serves FTS-ranked matches.
// Uses a SQLite FTS5 virtual table for ranked full-text search over title/artist.

import { Database } from 'bun:sqlite';
import type { MediaResolver, SearchResult } from './resolver';

export interface LocalTrack {
	sourceRef: string; // relative file path / key under MEDIA_DIR
	title: string;
	artist?: string;
	durationSec: number;
}

/**
 * Keep only the tracks whose file is actually on disk. `exists` is injected so this is pure and
 * testable without a filesystem. Indexing a missing file is worse than indexing nothing: it is a
 * searchable, queueable, processable song that CANNOT work, and a failed terminal job never clears
 * the phone's "processing" state — a song you cannot see is a smaller problem than one that lies.
 */
export function presentTracks(tracks: LocalTrack[], exists: (sourceRef: string) => boolean): LocalTrack[] {
	return tracks.filter((t) => exists(t.sourceRef));
}

/** Extensions the media route can already serve; anything else in the folder is not a track. */
const LIBRARY_EXTS = new Set(['mp4', 'm4a', 'mp3', 'wav', 'webm', 'opus', 'flac']);

/** PURE. `Artist - Title.mp4` is the convention a drop-in folder actually uses, so the hyphen is the seam;
 *  a name without one is all title, and inventing an artist from a folder name would be a guess. */
export function trackNameFromFile(fileName: string): { title: string; artist?: string } {
	const stem = fileName
		.replace(/\.[^.]+$/, '')
		.replace(/[_]+/g, ' ')
		.trim();
	const split = /^(.+?)\s+-\s+(.+)$/.exec(stem);
	if (!split) return { title: stem };
	return { artist: split[1]!.trim(), title: split[2]!.trim() };
}

/**
 * Turn the files under MEDIA_DIR/library into indexable tracks. `probe` is injected for the same reason
 * `exists` is above — so this is testable without ffmpeg or a filesystem.
 *
 * A file whose duration cannot be read is SKIPPED, not indexed at zero. That follows `presentTracks`'s rule:
 * a song that cannot work is worse than a song that is absent, and an unmeasurable file is one whose
 * playability is unproven. It is also what makes the placeholder-stub fixture fail loudly instead of
 * indexing four zero-length songs.
 */
export async function scanLibrary(
	files: string[],
	probe: (sourceRef: string) => Promise<number | null>
): Promise<{ tracks: LocalTrack[]; skipped: string[] }> {
	const tracks: LocalTrack[] = [];
	const skipped: string[] = [];
	for (const file of files) {
		const ext = file.split('.').pop()?.toLowerCase();
		if (!ext || !LIBRARY_EXTS.has(ext)) continue;
		const sourceRef = `library/${file}`;
		const durationSec = await probe(sourceRef);
		if (durationSec === null) {
			skipped.push(file);
			continue;
		}
		tracks.push({ sourceRef, durationSec, ...trackNameFromFile(file) });
	}
	return { tracks, skipped };
}

export class LocalLibrary implements MediaResolver {
	readonly kind = 'local' as const;
	#fts: Database;

	constructor() {
		// dedicated in-memory FTS index (rebuilt from disk scan on boot / refresh)
		this.#fts = new Database(':memory:');
		this.#fts.exec(
			`CREATE VIRTUAL TABLE tracks USING fts5(source_ref UNINDEXED, title, artist, duration_sec UNINDEXED);`
		);
	}

	/** Replace the index with a fresh set (called after a disk scan). */
	index(tracks: LocalTrack[]): void {
		this.#fts.exec('DELETE FROM tracks;');
		const ins = this.#fts.prepare('INSERT INTO tracks (source_ref, title, artist, duration_sec) VALUES (?, ?, ?, ?)');
		const tx = this.#fts.transaction((rows: LocalTrack[]) => {
			for (const t of rows) ins.run(t.sourceRef, t.title, t.artist ?? '', t.durationSec);
		});
		tx(tracks);
	}

	async search(query: string, limit: number): Promise<SearchResult[]> {
		const q = query.trim();
		if (!q) return [];
		// prefix-match each term; bm25() ranks (lower = better)
		const match = q
			.split(/\s+/)
			.map((t) => `${t.replace(/["']/g, '')}*`)
			.join(' ');
		const rows = this.#fts
			.prepare(
				`SELECT source_ref, title, artist, duration_sec FROM tracks
				 WHERE tracks MATCH ? ORDER BY bm25(tracks) LIMIT ?`
			)
			.all(match, limit) as Array<{ source_ref: string; title: string; artist: string; duration_sec: number }>;
		return rows.map((r) => ({
			source: 'local' as const,
			sourceRef: r.source_ref,
			title: r.title,
			artist: r.artist || undefined,
			durationSec: r.duration_sec
		}));
	}
}
