// Room repository — the FIRST production writer/reader of the `rooms` table.
//
// A room is one party: it owns an `id` (the internal handle the rest of the rooms chain scopes
// playback/queue/singers to) and a `code` (the short, human-typeable join code a phone enters or a
// QR encodes). This layer is deliberately minimal and foundational — it creates a room and looks
// one up by its code. It decides NOTHING about how a phone joins one (that is #654), nor about
// per-room playback/queue/singer scoping (#655/#656): those build ON this table being real.
//
// Kept in apps/core (not @encore/shared) on purpose: the wire contract carries no Room today, and
// #652 is explicitly scoped not to cross the shared package.

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/index';
import { rooms } from '../db/schema';
import { ulid } from '@encore/shared';

/** A persisted room. Shape mirrors the `rooms` table row. */
export interface Room {
	id: string;
	code: string;
	createdAt: number;
}

/**
 * Join-code alphabet: uppercase letters + digits with the visually confusable characters removed
 * (no 0/O, 1/I/L) so a code read off a TV and typed on a phone cannot be mistyped into a different
 * valid code. Six characters over this 30-symbol alphabet is ~7.3e8 possibilities — collisions are
 * vanishingly unlikely, and the unique index + retry below makes even one harmless.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/** Mint a random join code over {@link CODE_ALPHABET}. */
export function mintRoomCode(): string {
	const bytes = randomBytes(CODE_LENGTH);
	let code = '';
	for (let i = 0; i < CODE_LENGTH; i++) {
		code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
	}
	return code;
}

export class RoomRepository {
	#db: DB;
	constructor(db: DB) {
		this.#db = db;
	}

	/**
	 * Create a room, minting an `id` and a unique join `code`. Retries on the (vanishingly unlikely)
	 * code collision the `rooms_code_idx` unique constraint would otherwise reject, so the caller
	 * always gets back a room whose code is genuinely free. Throws only after exhausting the retries
	 * — a persistent failure there is a bug (or an impossibly full code space), not a normal path.
	 *
	 * `mintCode` is injectable so the retry branch is deterministically testable; production always
	 * uses the crypto-backed {@link mintRoomCode}.
	 */
	create(now: number, opts: { attempts?: number; mintCode?: () => string } = {}): Room {
		const attempts = opts.attempts ?? 5;
		const mint = opts.mintCode ?? mintRoomCode;
		let lastErr: unknown;
		for (let i = 0; i < attempts; i++) {
			const room: Room = { id: ulid(now), code: mint(), createdAt: now };
			try {
				this.#db.insert(rooms).values(room).run();
				return room;
			} catch (err) {
				// A UNIQUE violation on the code means we drew a code already in use: draw again.
				// Anything else is a real error and should surface immediately.
				if (!isUniqueViolation(err)) throw err;
				lastErr = err;
			}
		}
		throw new Error(`could not mint a free room code after ${attempts} attempts`, { cause: lastErr });
	}

	/** Look a room up by its join code, or null if no room carries it. */
	byCode(code: string): Room | null {
		if (!code) return null;
		return this.#db.select().from(rooms).where(eq(rooms.code, code)).all()[0] ?? null;
	}

	/** Look a room up by its internal id, or null. */
	byId(id: string): Room | null {
		if (!id) return null;
		return this.#db.select().from(rooms).where(eq(rooms.id, id)).all()[0] ?? null;
	}
}

/** True when the error is a SQLite UNIQUE constraint violation (bun:sqlite surfaces it in the message). */
function isUniqueViolation(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /UNIQUE constraint failed/i.test(msg);
}
