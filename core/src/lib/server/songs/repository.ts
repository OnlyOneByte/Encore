// Saved songs: the one table "Your songs" writes. Sung songs come from `performances`. See docs/SERVER.md#your-songs.

import { and, eq, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import type { DB } from '../db/index';
import { savedSongs, singers } from '../db/schema';
import { ulid, type Media } from '../../contract';
import { GUEST_NIGHTS_RETENTION_MS, type HistoryOwner } from '../nights/repository';

export type SavedSong = typeof savedSongs.$inferSelect;

export class SavedSongs {
	#db: DB;
	constructor(db: DB) {
		this.#db = db;
	}

	#owns(owner: HistoryOwner) {
		const singer = and(eq(savedSongs.ownerKind, 'singer'), eq(savedSongs.ownerId, owner.singerId));
		return owner.personId
			? or(singer, and(eq(savedSongs.ownerKind, 'person'), eq(savedSongs.ownerId, owner.personId)))
			: singer;
	}

	/** A kept caller's saves go to the person, so every phone of theirs has them; a guest's to tonight's singer. */
	save(owner: HistoryOwner, media: Media, now: number): SavedSong {
		const ownerKind = owner.personId ? ('person' as const) : ('singer' as const);
		const ownerId = owner.personId ?? owner.singerId;
		const row = {
			id: ulid(now),
			ownerKind,
			ownerId,
			source: media.source,
			sourceRef: media.sourceRef,
			title: media.title,
			artist: media.artist ?? null,
			savedAt: now
		};
		// Saving again keeps the first save's id and time.
		this.#db.insert(savedSongs).values(row).onConflictDoNothing().run();
		return this.#db
			.select()
			.from(savedSongs)
			.where(
				and(
					eq(savedSongs.ownerKind, ownerKind),
					eq(savedSongs.ownerId, ownerId),
					eq(savedSongs.source, row.source),
					eq(savedSongs.sourceRef, row.sourceRef)
				)
			)
			.all()[0]!;
	}

	listFor(owner: HistoryOwner): SavedSong[] {
		return this.#db.select().from(savedSongs).where(this.#owns(owner)).all();
	}

	/** Unsave a song: the owner's saves of its origin. False when they had none. */
	remove(owner: HistoryOwner, media: Pick<Media, 'source' | 'sourceRef'>): boolean {
		return (
			this.#db
				.delete(savedSongs)
				.where(and(this.#owns(owner), eq(savedSongs.source, media.source), eq(savedSongs.sourceRef, media.sourceRef)))
				.returning({ id: savedSongs.id })
				.all().length > 0
		);
	}

	/** Forget my songs: every save the owner can read. Returns how many went. */
	removeAll(owner: HistoryOwner): number {
		return this.#db.delete(savedSongs).where(this.#owns(owner)).returning({ id: savedSongs.id }).all().length;
	}

	/** Keep me: a guest's saves become the person's. A song the person already saved keeps that one. */
	linkPerson(singerId: string, personId: string): void {
		this.#db.transaction((tx) => {
			tx.run(
				sql`UPDATE OR IGNORE ${savedSongs} SET owner_kind = 'person', owner_id = ${personId}
					WHERE owner_kind = 'singer' AND owner_id = ${singerId}`
			);
			tx.delete(savedSongs)
				.where(and(eq(savedSongs.ownerKind, 'singer'), eq(savedSongs.ownerId, singerId)))
				.run();
		});
	}

	/** Delete me: the person's saves and those of every singer row of theirs. */
	forgetPerson(personId: string, singerIds: string[]): void {
		const person = and(eq(savedSongs.ownerKind, 'person'), eq(savedSongs.ownerId, personId));
		this.#db
			.delete(savedSongs)
			.where(
				singerIds.length
					? or(person, and(eq(savedSongs.ownerKind, 'singer'), inArray(savedSongs.ownerId, singerIds)))
					: person
			)
			.run();
	}

	/** Daily, with the guest nights sweep: a guest's saves once neither the singer nor a save of theirs has been
	 *  active for the retention window. */
	sweepGuests(now: number): number {
		const cutoff = now - GUEST_NIGHTS_RETENTION_MS;
		const recentSavers = this.#db
			.selectDistinct({ id: savedSongs.ownerId })
			.from(savedSongs)
			.where(and(eq(savedSongs.ownerKind, 'singer'), sql`${savedSongs.savedAt} > ${cutoff}`));
		// A singer row linked to a person is kept, not a guest, so its saves wait for Delete me like the person's.
		const activeOrKept = this.#db
			.select({ id: singers.id })
			.from(singers)
			.where(
				or(sql`${singers.joinedAt} > ${cutoff}`, sql`${singers.lastSungAt} > ${cutoff}`, isNotNull(singers.personId))
			);
		return this.#db
			.delete(savedSongs)
			.where(
				and(
					eq(savedSongs.ownerKind, 'singer'),
					notInArray(savedSongs.ownerId, recentSavers),
					notInArray(savedSongs.ownerId, activeOrKept)
				)
			)
			.returning({ id: savedSongs.id })
			.all().length;
	}
}
