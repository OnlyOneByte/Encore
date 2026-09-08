// Singer repository + session tokens. Singers are ephemeral identities (name + color) — no
// signup wall (ARCHITECTURE §1/§10). A crypto session token is minted on join and stored in a
// cookie; subsequent requests resolve the singer by that token.

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/index';
import { singers } from '../db/schema';
import { ulid, type Singer } from '@encore/shared';

/**
 * A singer AS STORED: the wire {@link Singer} plus the `room_id` scoping key (#656). The wire type
 * carries no room (a phone is never told its own room id), but the server reads it off the row to
 * scope the roster and the in-room name-uniqueness check — so the repository's row-returning reads
 * surface it while the public {@link SingerRepository.listPublic} strips it back off.
 */
export type StoredSinger = Singer & { roomId: string };

export const SESSION_COOKIE = 'encore_singer';

/**
 * The room a phone joined. Set by /api/join alongside the session cookie (#654) so the identity of
 * WHICH party this device belongs to survives every later request without re-resolving a join code.
 * The room-scoping chain reads it: #655 keyed playback by room, and #656 keys the queue + roster —
 * a singer is created IN a room and the roster is listed BY room. Scoping the token that names which
 * room a given socket may act in is #657.
 */
export const ROOM_COOKIE = 'encore_room';

/** Cryptographically-strong, URL-safe session token (NOT the ulid helper — that's for entry ids). */
export function mintSessionToken(): string {
	return randomBytes(24).toString('base64url');
}

export class SingerRepository {
	#db: DB;
	constructor(db: DB) {
		this.#db = db;
	}

	/**
	 * Create a singer IN a room, minting id + session token (#656).
	 *
	 * `roomId` is the party this singer belongs to — the room the /api/join resolved (an explicit code
	 * or the active room). It scopes the roster, the `least-recently-sung` ordering, and the presence
	 * sweep to one party, so two rooms no longer share one roster. The returned {@link Singer} carries
	 * no room field: the wire contract is unchanged (a phone never needs to be told its own room), so
	 * the column is a server-side scoping key, not new wire state.
	 */
	create(displayName: string, color: string, now: number, roomId: string): Singer {
		const singer: Singer = {
			id: ulid(now),
			displayName: displayName.trim().slice(0, 32) || 'Guest',
			color,
			sessionToken: mintSessionToken(),
			joinedAt: now
		};
		this.#db
			.insert(singers)
			.values({ ...singer, roomId })
			.run();
		return singer;
	}

	/** Resolve the singer behind a session token (from the cookie), or null. Carries `roomId` (#656). */
	bySessionToken(token: string | undefined | null): StoredSinger | null {
		if (!token) return null;
		const row = this.#db.select().from(singers).where(eq(singers.sessionToken, token)).all()[0];
		return row ?? null;
	}

	byId(id: string): StoredSinger | null {
		return this.#db.select().from(singers).where(eq(singers.id, id)).all()[0] ?? null;
	}

	/**
	 * Change a singer's name and colour. The FIRST update path this repository has had — it was
	 * create/read only, which is why a guest who mistyped their name was stuck with it all night.
	 *
	 * The session token is deliberately untouched: renaming is not re-joining, so the phone keeps its
	 * cookie and its place in the rotation.
	 */
	updateProfile(id: string, displayName: string, color: string): StoredSinger | null {
		const next = displayName.trim().slice(0, 32);
		if (!next) return null;
		this.#db.update(singers).set({ displayName: next, color }).where(eq(singers.id, id)).run();
		return this.byId(id);
	}

	/**
	 * Stamp that this singer has STARTED a song. Drives the `least-recently-sung` ordering.
	 *
	 * Records only that they sang and when — never what — so it stays inside the same privacy line the
	 * `plays` table draws (no singer id there, deliberately). Idempotent by nature: called from the
	 * one place a song becomes current, and a repeat write with the same timestamp changes nothing.
	 */
	markSang(singerId: string, now: number): void {
		this.#db.update(singers).set({ lastSungAt: now }).where(eq(singers.id, singerId)).run();
	}

	/**
	 * A ROOM's singers, without session tokens (safe to broadcast) (#656).
	 *
	 * Scoped by `room_id`: this feeds the room roster, the `least-recently-sung` ordering input, and
	 * the in-room name-uniqueness check, none of which may see another party's singers. `room_id` is a
	 * server-side key, so it is stripped alongside `sessionToken` — the public shape is unchanged.
	 */
	listPublic(roomId: string): Omit<Singer, 'sessionToken'>[] {
		return this.#db
			.select()
			.from(singers)
			.where(eq(singers.roomId, roomId))
			.all()
			.map(({ sessionToken: _t, roomId: _r, ...rest }) => rest);
	}
}

/** Parse our session token out of a Cookie header. */
export function readSessionToken(cookieHeader: string | null): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(';')) {
		const [k, v] = part.trim().split('=');
		if (k === SESSION_COOKIE) return v;
	}
	return undefined;
}
