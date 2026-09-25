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

/** A character the unicode61 tokenizer will actually index. A term made only of punctuation tokenizes to NOTHING, and
 * an empty FTS5 phrase (`""`) is a syntax error in its own right, so such terms are dropped rather than quoted. */
const TOKEN_CHAR = /[\p{L}\p{N}]/u;

/**
 * A prefix query over every term, each one QUOTED. The quoting is the whole point: inside a double-quoted FTS5 string
 * every character is literal text to be tokenized, so `(`, `:`, `*`, `^` and the bare AND/OR/NOT/NEAR keywords lose
 * their syntactic meaning. Unquoted, they kept it — `sam (live)` and `nirvana: mtv` were SYNTAX ERRORS, which threw
 * from `.all()`, and `safeSearch` in /api/search catches a dead resolver so the whole local library silently returned
 * nothing. A punctuated query therefore dropped every local song and looked like an empty library rather than a
 * failure. The old `replace(/["']/g, '')` addressed only the two quote characters, and stripping the apostrophe was
 * itself a miss: `dont*` does not match the `don` + `t` tokens FTS5 indexes for "don't".
 *
 * `"term"*` is a phrase-prefix query, so the `*` MUST sit outside the closing quote — inside, it is just an asterisk
 * to tokenize away. A literal `"` inside a string doubles, per FTS5.
 */
export function ftsPrefixQuery(query: string): string {
	return query
		.split(/\s+/)
		.filter((t) => TOKEN_CHAR.test(t))
		.map((t) => `"${t.replace(/"/g, '""')}"*`)
		.join(' ');
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
		const match = ftsPrefixQuery(query);
		if (!match) return [];
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
