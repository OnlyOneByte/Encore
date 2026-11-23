// The host's key: who may change settings, read the operator pages and delete songs. See docs/SERVER.md#the-host-key.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, lte } from 'drizzle-orm';
import type { DB } from './db/index';
import { hostSessions } from './db/schema';
import { hashToken } from './singers/repository';

export const HOST_COOKIE = 'encore_host';
export const HOST_SESSION_MS = 30 * 86_400_000;

function digest(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

/** Free wrong tries per address before the backoff starts; then 1 min, doubling per wrong try, capped at 1 h. */
const FREE_TRIES = 5;
const FIRST_LOCKOUT_MS = 60_000;
const MAX_LOCKOUT_MS = 3_600_000;
const TRACKED_MAX = 1024;

/** At least this long, or core refuses to start: the key is then too long to guess within the backoff below. */
export const ADMIN_TOKEN_MIN = 24;

/** Why `ENCORE_ADMIN_TOKEN` cannot be used, or null when it is unset or long enough. */
export function adminTokenProblem(raw: string | null | undefined): string | null {
	const token = raw?.trim();
	if (!token || token.length >= ADMIN_TOKEN_MIN) return null;
	return `ENCORE_ADMIN_TOKEN is ${token.length} characters; it must be at least ${ADMIN_TOKEN_MIN}, or unset it to get a new key at every start.`;
}

/** Wrong-key tries per client address. It does not slow guessing, because the right key is always accepted; it
 *  only answers 429 instead of 403 once an address is over its tries. Key length is what stops brute force. */
export class KeyTries {
	/** Insertion order is last-touched order, so the first entry found is the oldest. */
	#by = new Map<string, { wrong: number; until: number }>();
	readonly #max: number;

	constructor(max = TRACKED_MAX) {
		this.#max = max;
	}

	/** Milliseconds this address must wait before another wrong key is heard, or 0. */
	wait(addr: string, now: number): number {
		const entry = this.#by.get(addr);
		if (entry) return Math.max(0, entry.until - now);
		// A table full of locked addresses has no room for a new one, which waits rather than evicting a lock.
		return this.#room(now) ? 0 : FIRST_LOCKOUT_MS;
	}

	wrong(addr: string, now: number): void {
		const entry = this.#by.get(addr);
		if (!entry && !this.#room(now)) return;
		const wrong = (entry?.wrong ?? 0) + 1;
		const over = wrong - FREE_TRIES;
		const until = over > 0 ? now + Math.min(MAX_LOCKOUT_MS, FIRST_LOCKOUT_MS * 2 ** (over - 1)) : 0;
		this.#by.delete(addr);
		this.#by.set(addr, { wrong, until });
	}

	right(addr: string): void {
		this.#by.delete(addr);
	}

	/** Make room for one more address when full: the oldest still within its free tries, else the oldest whose
	 *  lockout has run out. A locked address is never dropped, so flooding cannot reset one. */
	#room(now: number): boolean {
		if (this.#by.size < this.#max) return true;
		let expired: string | null = null;
		for (const [addr, e] of this.#by) {
			if (e.until === 0) {
				this.#by.delete(addr);
				return true;
			}
			if (expired === null && e.until <= now) expired = addr;
		}
		if (expired === null) return false;
		this.#by.delete(expired);
		return true;
	}
}

export class HostKey {
	readonly tries = new KeyTries();
	#db: DB;
	#key: Buffer;
	/** The plain key, held only until server.ts prints the boot link. Null when it came from ENCORE_ADMIN_TOKEN. */
	#bootKey: string | null;

	constructor(db: DB, adminToken: string | null | undefined) {
		this.#db = db;
		const problem = adminTokenProblem(adminToken);
		if (problem) throw new Error(problem);
		const fixed = adminToken?.trim() || null;
		const key = fixed ?? randomBytes(32).toString('base64url');
		this.#key = digest(key);
		this.#bootKey = fixed ? null : key;
	}

	/** The minted key, once, for the boot banner. Null after the first call and when ENCORE_ADMIN_TOKEN is set. */
	takeBootKey(): string | null {
		const key = this.#bootKey;
		this.#bootKey = null;
		return key;
	}

	/** Constant-time: both sides are hashed to 32 bytes first, so neither length nor content leaks. */
	matches(presented: unknown): boolean {
		if (typeof presented !== 'string' || !presented) return false;
		return timingSafeEqual(digest(presented), this.#key);
	}

	/** A new host session. The returned token is the cookie value; only its hash is stored. */
	open(now: number): string {
		const token = randomBytes(32).toString('base64url');
		this.#db
			.insert(hostSessions)
			.values({ tokenHash: hashToken(token), createdAt: now, expiresAt: now + HOST_SESSION_MS })
			.run();
		return token;
	}

	isHost(token: string | undefined | null, now: number): boolean {
		if (!token) return false;
		const row = this.#db
			.select()
			.from(hostSessions)
			.where(eq(hostSessions.tokenHash, hashToken(token)))
			.all()[0];
		return Boolean(row && row.expiresAt > now);
	}

	/** Signs out every host phone, this one included. */
	revokeAll(): void {
		this.#db.delete(hostSessions).run();
	}

	pruneExpired(now: number): void {
		this.#db.delete(hostSessions).where(lte(hostSessions.expiresAt, now)).run();
	}
}
