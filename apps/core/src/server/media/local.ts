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
 * testable without a filesystem.
 *
 * Indexing a track whose file is missing is worse than indexing nothing: it is a searchable,
 * queueable, cookable song that CANNOT work. The dev seed listed four such demos, and cooking one
 * failed with `ffmpeg exited 254: No such file or directory` three times over (once per attempt)
 * and then left the media pinned in the phone's "cooking" list forever, because a terminal job
 * never clears that state. A song you cannot see is a much smaller problem than one that lies.
 */
export function presentTracks(tracks: LocalTrack[], exists: (sourceRef: string) => boolean): LocalTrack[] {
	return tracks.filter((t) => exists(t.sourceRef));
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
		const ins = this.#fts.prepare(
			'INSERT INTO tracks (source_ref, title, artist, duration_sec) VALUES (?, ?, ?, ?)'
		);
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
