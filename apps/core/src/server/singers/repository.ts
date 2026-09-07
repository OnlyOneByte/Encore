// Singer repository + session tokens. Singers are ephemeral identities (name + color) — no
// signup wall (ARCHITECTURE §1/§10). A crypto session token is minted on join and stored in a
// cookie; subsequent requests resolve the singer by that token.

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/index';
import { singers } from '../db/schema';
import { ulid, type Singer } from '@encore/shared';

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

	/** Create a singer, minting id + session token. */
	create(displayName: string, color: string, now: number): Singer {
		const singer: Singer = {
			id: ulid(now),
			displayName: displayName.trim().slice(0, 32) || 'Guest',
			color,
			sessionToken: mintSessionToken(),
			joinedAt: now
		};
		this.#db.insert(singers).values(singer).run();
		return singer;
	}

	/** Resolve the singer behind a session token (from the cookie), or null. */
	bySessionToken(token: string | undefined | null): Singer | null {
		if (!token) return null;
		const row = this.#db.select().from(singers).where(eq(singers.sessionToken, token)).all()[0];
		return row ?? null;
	}

	byId(id: string): Singer | null {
		return this.#db.select().from(singers).where(eq(singers.id, id)).all()[0] ?? null;
	}

	/**
	 * Change a singer's name and colour. The FIRST update path this repository has had — it was
	 * create/read only, which is why a guest who mistyped their name was stuck with it all night.
	 *
	 * The session token is deliberately untouched: renaming is not re-joining, so the phone keeps its
	 * cookie and its place in the rotation.
	 */
	updateProfile(id: string, displayName: string, color: string): Singer | null {
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

	/** All singers, without session tokens (safe to broadcast). */
	listPublic(): Omit<Singer, 'sessionToken'>[] {
		return this.#db
			.select()
			.from(singers)
			.all()
			.map(({ sessionToken: _t, ...rest }) => rest);
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
