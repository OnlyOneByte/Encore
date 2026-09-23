// Durable play log — one row per performance, the only thing that can answer WHEN. Does NOT replace
// the sidecar's `library.playCount` (still authoritative for the lifetime total; retention's LRU
// reads `lastPlayedAt`) — a counter has no time axis. `queue_entries` can't answer either: it's
// deleted whole on every persistence flush, leaving no trace of a finished performance. No singer
// column by design — see the `plays` table comment in schema.ts.

import { desc, eq, gte, sql } from 'drizzle-orm';
import type { DB } from '../db/index';
import { plays } from '../db/schema';
import { ulid } from '../../contract';

/** A song and how many times it was played in the window asked for. */
export interface PlayCount {
	mediaId: string;
	plays: number;
}

/** Plays bucketed into a day, for the trend line. `day` is an ISO date (UTC). */
export interface PlaysPerDay {
	day: string;
	plays: number;
}

export class PlayLog {
	#db: DB;
	constructor(db: DB) {
		this.#db = db;
	}

	/**
	 * Record one play. Idempotent on `entryId`: PlayTracker's in-memory dedupe resets on restart
	 * while the DB's unique index does not, so replaying the entry on screen when the server died
	 * would otherwise double-count it — this swallows that conflict rather than throwing into playback.
	 */
	record(mediaId: string, entryId: string, now: number): void {
		this.#db
			.insert(plays)
			.values({ id: ulid(now), mediaId, entryId, at: now })
			.onConflictDoNothing()
			.run();
	}

	/** Total plays ever recorded IN THIS LOG. Not the lifetime total — see the header. */
	total(): number {
		return this.#count();
	}

	/** Plays at or after `since`. This is the question the sidecar counter cannot answer. */
	totalSince(since: number): number {
		return this.#count(since);
	}

	/** Most-played songs, newest-window-first. `since` omitted = the whole log. */
	topSongs(limit = 10, since?: number): PlayCount[] {
		const rows = this.#db
			.select({ mediaId: plays.mediaId, plays: sql<number>`count(*)` })
			.from(plays)
			.where(since === undefined ? undefined : gte(plays.at, since))
			.groupBy(plays.mediaId)
			.orderBy(desc(sql`count(*)`))
			.limit(limit)
			.all();
		return rows.map((r) => ({ mediaId: r.mediaId, plays: Number(r.plays) }));
	}

	/**
	 * Plays per UTC day, oldest first. Days with NO plays are absent, not zero-filled — the log can't
	 * tell "nobody sang" from "the server was off", so a synthetic zero would draw both identically;
	 * the caller decides how to render a gap.
	 */
	perDay(since: number): PlaysPerDay[] {
		const rows = this.#db
			.select({
				day: sql<string>`strftime('%Y-%m-%d', ${plays.at} / 1000, 'unixepoch')`,
				plays: sql<number>`count(*)`
			})
			.from(plays)
			.where(gte(plays.at, since))
			.groupBy(sql`1`)
			.orderBy(sql`1`)
			.all();
		return rows.map((r) => ({ day: r.day, plays: Number(r.plays) }));
	}

	/** Every play of one song, newest first — the per-song history on the audit page. */
	forMedia(mediaId: string, limit = 100): { at: number; entryId: string }[] {
		return this.#db
			.select({ at: plays.at, entryId: plays.entryId })
			.from(plays)
			.where(eq(plays.mediaId, mediaId))
			.orderBy(desc(plays.at))
			.limit(limit)
			.all();
	}

	/** How many distinct songs have ever been played. */
	distinctSongs(): number {
		const row = this.#db
			.select({ n: sql<number>`count(distinct ${plays.mediaId})` })
			.from(plays)
			.all()[0];
		return Number(row?.n ?? 0);
	}

	#count(since?: number): number {
		const row = this.#db
			.select({ n: sql<number>`count(*)` })
			.from(plays)
			.where(since === undefined ? undefined : gte(plays.at, since))
			.all()[0];
		return Number(row?.n ?? 0);
	}
}
