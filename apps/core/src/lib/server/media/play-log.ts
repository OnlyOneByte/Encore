// Durable play log — one row per performance, and the only thing that can answer WHEN.
//
// This does NOT replace the sidecar's `library.playCount`: that stays the authoritative lifetime
// total, and retention's LRU still reads `lastPlayedAt`. What a counter cannot do is carry a time
// axis, so "songs sung tonight", "plays this week" and any trend line are unanswerable from it.
// `queue_entries` cannot answer either — it is deleted whole on every persistence flush and terminal
// rows are dropped again on boot, so a finished performance leaves no trace anywhere.
//
// Deliberately no singer column. See the `plays` table comment in schema.ts.

import { desc, eq, gte, sql } from 'drizzle-orm';
import type { DB } from '../db/index';
import { plays } from '../db/schema';
import { ulid } from '$lib/contract';

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
	 * Record one play. Idempotent on `entryId`: the in-memory PlayTracker dedupes re-emits, but its
	 * state resets on restart while the DB's does not — so replaying the entry that was on screen when
	 * the server went down would otherwise double-count it. The unique index makes that impossible and
	 * this swallows the conflict rather than throwing into the playback path.
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
	 * Plays per UTC day, oldest first. Days with NO plays are absent rather than zero-filled: the log
	 * cannot distinguish "nobody sang" from "the server was off", so inventing a zero would draw a
	 * quiet night and an outage identically. The caller decides how to render a gap.
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
