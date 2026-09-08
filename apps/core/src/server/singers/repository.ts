// Singer repository + session tokens. Singers are ephemeral identities (name + color) — no
// signup wall (ARCHITECTURE §1/§10). A crypto session token is minted on join and stored in a
// cookie; subsequent requests resolve the singer by that token.

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/index';
import { singers } from '../db/schema';
import { ulid, type Singer } from '@encore/shared';

/**
 * A singer AS STORED: the wire {@link Singer} plus the `room_id` scoping key (#656). The server reads
 * the room off the row to scope the roster and the in-room name-uniqueness check, so the repository's
 * row-returning reads surface it.
 *
 * A phone DOES learn its own room id — `/api/join` returns it in the response body, deliberately, so
 * the device knows which party it is in. What strips `room_id` is the ROSTER: {@link
 * SingerRepository.listPublic} drops it because a roster entry of somebody else carries no use for it
 * and the public shape is the wire `Singer`. Any other projection of a `StoredSinger` onto the wire
 * has to drop it too, for the same reason — `/api/me` does, so its `singer:updated` frame matches
 * `PublicSinger` (#797).
 */
export type StoredSinger = Singer & { roomId: string };

export const SESSION_COOKIE = 'encore_singer';

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
	 * no room field: the wire `Singer` contract is unchanged, so the column is a server-side scoping
	 * key rather than new wire state. The joining phone still learns its own room — /api/join returns
	 * `roomId` beside the singer (#797).
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
