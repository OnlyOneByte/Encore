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
