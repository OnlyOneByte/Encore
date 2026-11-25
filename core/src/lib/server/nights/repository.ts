// Your night: each singer's own turns, grouped into nights, for their recap. See docs/SERVER.md#your-night.

import { and, desc, eq, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import type { DB } from '../db/index';
import { nightOptOuts, nights, performances } from '../db/schema';
import { ulid } from '../../contract';

/** A room's night ends after this long with no turn; the next turn starts a new one. */
export const NIGHT_GAP_MS = 6 * 3_600_000;
/** A guest's turns go after this; a kept person's stay until Delete me. */
export const GUEST_NIGHTS_RETENTION_MS = 90 * 86_400_000;
export const NIGHT_SWEEP_EVERY_MS = 86_400_000;

export type TurnEnd = 'finished' | 'skipped' | 'failed';

export interface Turn {
	roomId: string;
	singerId: string;
	personId: string | null;
	mediaId: string;
	entryId: string;
	startedAt: number;
	endedAt: number;
	end: TurnEnd;
	keyShift: number;
	guideLevel: number | null;
}

export interface TurnCounts {
	keyChanges: number;
	cheers: number;
}

/** Whose history a read or delete covers: tonight's singer, and their kept person when the device proves it. */
export interface HistoryOwner {
	singerId: string;
	personId: string | null;
}

export interface NightSummary {
	id: string;
	startedAt: number;
	endedAt: number;
	songs: number;
}

export type Performance = typeof performances.$inferSelect;

export class NightLog {
	#db: DB;
	/** Key changes and cheers for each turn on stage, flushed into its row when it ends.
	 *  shortcut: in memory, so a restart mid-song loses that song's counts; persist them if that ever matters. */
	#tally = new Map<string, TurnCounts>();

	constructor(db: DB) {
		this.#db = db;
	}

	#counts(entryId: string) {
		let t = this.#tally.get(entryId);
		if (!t) {
			// Only the turn on stage counts, so one that left another way (removed, its song deleted) goes here.
			this.#tally.clear();
			this.#tally.set(entryId, (t = { keyChanges: 0, cheers: 0 }));
		}
		return t;
	}

	keyChanged(entryId: string): void {
		this.#counts(entryId).keyChanges++;
	}

	cheered(entryId: string): void {
		this.#counts(entryId).cheers++;
	}

	/** A turn's counts, taken the moment it ends. */
	take(entryId: string): TurnCounts {
		const counts = this.#tally.get(entryId) ?? { keyChanges: 0, cheers: 0 };
		this.#tally.delete(entryId);
		return counts;
	}

	/** One row per entry. A failed turn sung again on Try again keeps its row and takes the later outcome. */
	record(turn: Turn, counts: TurnCounts): void {
		this.#db.transaction((tx) => {
			const last = tx
				.select()
				.from(nights)
				.where(eq(nights.roomId, turn.roomId))
				.orderBy(desc(nights.endedAt))
				.limit(1)
				.all()[0];
			let nightId: string;
			if (last && turn.startedAt - last.endedAt < NIGHT_GAP_MS) {
				nightId = last.id;
				tx.update(nights)
					.set({ endedAt: Math.max(last.endedAt, turn.endedAt) })
					.where(eq(nights.id, nightId))
					.run();
			} else {
				nightId = ulid(turn.startedAt);
				tx.insert(nights)
					.values({ id: nightId, roomId: turn.roomId, startedAt: turn.startedAt, endedAt: turn.endedAt })
					.run();
			}
			const row = { ...turn, ...counts, nightId };
			tx.insert(performances)
				.values({ id: ulid(turn.endedAt), ...row })
				.onConflictDoUpdate({
					target: performances.entryId,
					set: {
						endedAt: row.endedAt,
						end: row.end,
						keyShift: row.keyShift,
						guideLevel: row.guideLevel,
						keyChanges: sql`${performances.keyChanges} + ${row.keyChanges}`,
						cheers: sql`${performances.cheers} + ${row.cheers}`
					}
				})
				.run();
		});
	}

	#owns(owner: HistoryOwner) {
		return owner.personId
			? or(eq(performances.singerId, owner.singerId), eq(performances.personId, owner.personId))
			: eq(performances.singerId, owner.singerId);
	}

	/** The owner's nights, newest first. Times span the owner's own turns, so no one else's reach them. A turn that
	 *  would not play is not a song sung: it counts in neither the songs nor the times, as in the phone's story. */
	nightsFor(owner: HistoryOwner): NightSummary[] {
		return this.#db
			.select({
				id: performances.nightId,
				startedAt: sql<number>`min(${performances.startedAt})`,
				endedAt: sql<number>`max(${performances.endedAt})`,
				songs: sql<number>`count(*)`
			})
			.from(performances)
			.where(and(this.#owns(owner), ne(performances.end, 'failed')))
			.groupBy(performances.nightId)
			.orderBy(desc(sql`2`))
			.all()
			.map((n) => ({ ...n, startedAt: Number(n.startedAt), endedAt: Number(n.endedAt), songs: Number(n.songs) }));
	}

	/** The owner's own turns in one night, oldest first; null when they sang none in it. */
	night(owner: HistoryOwner, nightId: string): { night: NightSummary; turns: Performance[] } | null {
		const turns = this.#db
			.select()
			.from(performances)
			.where(and(eq(performances.nightId, nightId), this.#owns(owner)))
			.orderBy(performances.startedAt)
			.all();
		if (turns.length === 0) return null;
		const night = {
			id: nightId,
			startedAt: turns[0]!.startedAt,
			endedAt: Math.max(...turns.map((t) => t.endedAt)),
			songs: turns.length
		};
		return { night, turns };
	}

	/** Every turn the owner can read, oldest first: what "Your songs" and the export are built from. */
	turnsFor(owner: HistoryOwner): Performance[] {
		return this.#db.select().from(performances).where(this.#owns(owner)).orderBy(performances.endedAt).all();
	}

	/** Delete my history: every row the owner can read. Returns how many went. */
	deleteFor(owner: HistoryOwner): number {
		return this.#db.delete(performances).where(this.#owns(owner)).returning({ id: performances.id }).all().length;
	}

	/** Keep me: tonight's turns so far become the person's, and so does "Don't keep my nights". */
	linkPerson(singerId: string, personId: string, now: number): void {
		this.#db.transaction((tx) => {
			tx.update(performances).set({ personId }).where(eq(performances.singerId, singerId)).run();
			const optedOut = tx.select().from(nightOptOuts).where(eq(nightOptOuts.subjectId, singerId)).all().length > 0;
			if (optedOut) tx.insert(nightOptOuts).values({ subjectId: personId, createdAt: now }).onConflictDoNothing().run();
		});
	}

	/** Delete me: every turn of the person, on any phone, and their opt-out with them. */
	forgetPerson(personId: string, singerIds: string[]): void {
		this.#db.transaction((tx) => {
			tx.delete(performances)
				.where(
					singerIds.length
						? or(eq(performances.personId, personId), inArray(performances.singerId, singerIds))
						: eq(performances.personId, personId)
				)
				.run();
			tx.delete(nightOptOuts).where(eq(nightOptOuts.subjectId, personId)).run();
		});
	}

	/** Recording is on unless the singer, or the person they are kept as, said "Don't keep my nights". */
	isRecording(subjects: (string | null)[]): boolean {
		const ids = subjects.filter((s): s is string => !!s);
		return this.#db.select().from(nightOptOuts).where(inArray(nightOptOuts.subjectId, ids)).all().length === 0;
	}

	setRecording(subjects: string[], on: boolean, now: number): void {
		if (on) {
			this.#db.delete(nightOptOuts).where(inArray(nightOptOuts.subjectId, subjects)).run();
			return;
		}
		for (const subjectId of subjects)
			this.#db.insert(nightOptOuts).values({ subjectId, createdAt: now }).onConflictDoNothing().run();
	}

	/** Daily: guests' turns past the retention window, then nights left with no turns. Opt-outs stay: one is only an id. */
	sweepGuests(now: number): number {
		const cutoff = now - GUEST_NIGHTS_RETENTION_MS;
		return this.#db.transaction((tx) => {
			const gone = tx
				.delete(performances)
				.where(and(isNull(performances.personId), lte(performances.endedAt, cutoff)))
				.returning({ id: performances.id })
				.all().length;
			const inUse = tx.selectDistinct({ id: performances.nightId }).from(performances);
			tx.delete(nights)
				.where(and(lte(nights.endedAt, cutoff), notInArray(nights.id, inUse)))
				.run();
			return gone;
		});
	}
}
