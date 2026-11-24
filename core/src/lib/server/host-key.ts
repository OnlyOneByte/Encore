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

/** At least this long, or core refuses to start. Key length is the only brute-force defence: see docs/SERVER.md. */
export const ADMIN_TOKEN_MIN = 24;

/** Why `ENCORE_ADMIN_TOKEN` cannot be used, or null when it is unset or long enough. */
export function adminTokenProblem(raw: string | null | undefined): string | null {
	const token = raw?.trim();
	if (!token || token.length >= ADMIN_TOKEN_MIN) return null;
	return `ENCORE_ADMIN_TOKEN is ${token.length} characters; it must be at least ${ADMIN_TOKEN_MIN}, or unset it to get a new key at every start.`;
}

export class HostKey {
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
