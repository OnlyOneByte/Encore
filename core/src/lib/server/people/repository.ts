// Kept people and the phones they are kept on. See docs/SERVER.md#kept-people.

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import type { DB } from '../db/index';
import { people, personDevices } from '../db/schema';
import { hashToken } from '../singers/repository';
import { ulid } from '../../contract';

export const DEVICE_COOKIE = 'encore_device';
/** Over HTTPS the cookie takes the `__Host-` prefix, so a plain-HTTP sibling on this host cannot plant one. */
export const DEVICE_COOKIE_SECURE = `__Host-${DEVICE_COOKIE}`;
export const DEVICE_COOKIE_MAX_AGE_S = 365 * 86_400;
/** A phone not used for this long is signed out on the server, whatever its cookie says. */
export const DEVICE_IDLE_MS = 180 * 86_400_000;

const mintDeviceToken = () => randomBytes(32).toString('base64url');

export interface Person {
	id: string;
	displayName: string;
	color: string;
}

/** How long the token before a rotation still works, at most; its first use of the new one ends it sooner. */
export const ROTATION_GRACE_MS = 2 * 60_000;

export interface KeptDevice {
	person: Person;
	deviceId: string;
	/** The device's CURRENT plain token: the one presented, or, for a grace use of the previous one, the one it
	 *  rotated to, which the caller re-sends. */
	token: string;
	/** The previous token was presented inside its grace window. */
	viaGrace: boolean;
}

const nextToken = (salt: string, previous: string) =>
	createHash('sha256').update(`${salt}:${previous}`).digest('base64url');

export class PeopleRepository {
	#db: DB;
	constructor(db: DB) {
		this.#db = db;
	}

	/** A new person on a new device. The returned token is the cookie value; only its hash is stored. */
	create(displayName: string, color: string, now: number): { person: Person; token: string } {
		const person: Person = { id: ulid(now), displayName, color };
		const token = mintDeviceToken();
		this.#db.transaction((tx) => {
			tx.insert(people)
				.values({ ...person, createdAt: now })
				.run();
			tx.insert(personDevices)
				.values({ id: ulid(now), personId: person.id, tokenHash: hashToken(token), createdAt: now, lastSeenAt: now })
				.run();
		});
		return { person, token };
	}

	/** The person a device cookie names, or null when it is unknown, signed out, idle too long, or the previous token
	 *  past its grace. Presenting the current token ends the previous one's grace. */
	byDevice(token: string | undefined | null, now: number): KeptDevice | null {
		if (!token) return null;
		const hash = hashToken(token);
		const row = this.#db
			.select({
				deviceId: personDevices.id,
				lastSeenAt: personDevices.lastSeenAt,
				tokenHash: personDevices.tokenHash,
				prevTokenHash: personDevices.prevTokenHash,
				prevValidUntil: personDevices.prevValidUntil,
				rotationSalt: personDevices.rotationSalt,
				id: people.id,
				displayName: people.displayName,
				color: people.color
			})
			.from(personDevices)
			.innerJoin(people, eq(people.id, personDevices.personId))
			.where(or(eq(personDevices.tokenHash, hash), eq(personDevices.prevTokenHash, hash)))
			.all()[0];
		if (!row || now - row.lastSeenAt >= DEVICE_IDLE_MS) return null;
		const person = { id: row.id, displayName: row.displayName, color: row.color };
		if (row.tokenHash === hash) {
			if (row.prevTokenHash) this.#endGrace(row.deviceId);
			return { deviceId: row.deviceId, person, token, viaGrace: false };
		}
		if (!row.rotationSalt || (row.prevValidUntil ?? 0) <= now) {
			// The salt plus an old cookie would derive the live token, so it goes as soon as it is no use.
			this.#endGrace(row.deviceId);
			return null;
		}
		return { deviceId: row.deviceId, person, token: nextToken(row.rotationSalt, token), viaGrace: true };
	}

	/** The phone's /ws upgrade carries its cookies about a second after a join: seeing the new token there is its
	 *  first use, so the previous token's grace ends then rather than at a later page load. Both cookie names are
	 *  read, since this only ever narrows what is accepted. */
	seenOnSocket(cookieHeader: string | null, now: number): void {
		for (const part of cookieHeader?.split(';') ?? []) {
			const [k, v] = part.trim().split('=');
			if (k === DEVICE_COOKIE || k === DEVICE_COOKIE_SECURE) this.byDevice(v, now);
		}
	}

	/** For the reaper tick: forget every grace that has run out unused. */
	clearExpiredGrace(now: number): void {
		this.#db
			.update(personDevices)
			.set({ prevTokenHash: null, prevValidUntil: null, rotationSalt: null })
			.where(lte(personDevices.prevValidUntil, now))
			.run();
	}

	#endGrace(deviceId: string): void {
		this.#db
			.update(personDevices)
			.set({ prevTokenHash: null, prevValidUntil: null, rotationSalt: null })
			.where(eq(personDevices.id, deviceId))
			.run();
	}

	/** A new token for this device, derived from the `current` one presented. That one stays valid for
	 *  ROTATION_GRACE_MS or until the new one is first used, so a response lost on the way to the phone does not
	 *  un-keep it; any older copy stops working at once. Returns the new cookie value. */
	rotate(deviceId: string, current: string, now: number): string {
		const salt = randomBytes(16).toString('base64url');
		const token = nextToken(salt, current);
		this.#db
			.update(personDevices)
			.set({
				tokenHash: hashToken(token),
				prevTokenHash: hashToken(current),
				prevValidUntil: now + ROTATION_GRACE_MS,
				rotationSalt: salt,
				lastSeenAt: now
			})
			.where(eq(personDevices.id, deviceId))
			.run();
		return token;
	}

	touch(deviceId: string, now: number): void {
		this.#db.update(personDevices).set({ lastSeenAt: now }).where(eq(personDevices.id, deviceId)).run();
	}

	exists(personId: string): boolean {
		return this.#db.select({ id: people.id }).from(people).where(eq(people.id, personId)).all().length > 0;
	}

	update(personId: string, displayName: string, color: string): void {
		this.#db.update(people).set({ displayName, color }).where(eq(people.id, personId)).run();
	}

	otherDeviceCount(personId: string, deviceId: string): number {
		return this.#db
			.select({ id: personDevices.id })
			.from(personDevices)
			.where(and(eq(personDevices.personId, personId), ne(personDevices.id, deviceId)))
			.all().length;
	}

	signOutOthers(personId: string, deviceId: string): void {
		this.#db
			.delete(personDevices)
			.where(and(eq(personDevices.personId, personId), ne(personDevices.id, deviceId)))
			.run();
	}

	/** Every kept person, with how many phones they are kept on, for the host page. */
	list(): (Person & { phones: number })[] {
		return this.#db
			.select({
				id: people.id,
				displayName: people.displayName,
				color: people.color,
				phones: sql<number>`count(${personDevices.id})`
			})
			.from(people)
			.leftJoin(personDevices, eq(personDevices.personId, people.id))
			.groupBy(people.id)
			.orderBy(people.displayName)
			.all();
	}

	/** The person and every device of theirs. Their nights are the caller's: see `forgetPerson`. */
	delete(personId: string): void {
		this.#db.transaction((tx) => {
			tx.delete(personDevices).where(eq(personDevices.personId, personId)).run();
			tx.delete(people).where(eq(people.id, personId)).run();
		});
	}

	/** Drops idle devices and returns the people left with none, who can no longer come back. */
	pruneIdle(now: number): string[] {
		this.#db
			.delete(personDevices)
			.where(lte(personDevices.lastSeenAt, now - DEVICE_IDLE_MS))
			.run();
		const withDevice = this.#db.selectDistinct({ id: personDevices.personId }).from(personDevices);
		return this.#db
			.select({ id: people.id })
			.from(people)
			.where(notInArray(people.id, withDevice))
			.all()
			.map((r) => r.id);
	}
}
