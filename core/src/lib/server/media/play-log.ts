// One row per performance, the only thing that can answer WHEN. Does NOT replace the sidecar's
// `library.playCount`, still authoritative for the lifetime total, and `queue_entries` cannot answer either:
// it is deleted whole on every persistence flush. No singer column, by design.

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

	/** Idempotent on `entryId`: the in-memory dedupe resets on restart while the unique index does not, so
	 *  this swallows the conflict rather than throwing into playback. */
	record(mediaId: string, entryId: string, now: number): void {
		this.#db
			.insert(plays)
			.values({ id: ulid(now), mediaId, entryId, at: now })
			.onConflictDoNothing()
			.run();
	}

	/** IN THIS LOG, not the lifetime total. */
	total(): number {
		return this.#count();
	}

	/** The question the sidecar counter cannot answer. */
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

	/** A day with NO plays is ABSENT, never zero-filled: the log cannot tell "nobody sang" from "the server
	 *  was off", so a synthetic zero would draw both identically. */
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

	/** Newest first. */
	forMedia(mediaId: string, limit = 100): { at: number; entryId: string }[] {
		return this.#db
			.select({ at: plays.at, entryId: plays.entryId })
			.from(plays)
			.where(eq(plays.mediaId, mediaId))
			.orderBy(desc(plays.at))
			.limit(limit)
			.all();
	}

	/** Every play at or after `since`, oldest first. */
	since(since: number): { entryId: string; at: number }[] {
		return this.#db
			.select({ entryId: plays.entryId, at: plays.at })
			.from(plays)
			.where(gte(plays.at, since))
			.orderBy(plays.at)
			.all();
	}

	/** When this entry first went on stage, or null if it never did. */
	startedAt(entryId: string): number | null {
		return this.#db.select({ at: plays.at }).from(plays).where(eq(plays.entryId, entryId)).all()[0]?.at ?? null;
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
