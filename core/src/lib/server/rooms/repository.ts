// Room repository: a party is named by an `id` (the internal handle the rest of the rooms chain scopes playback/queue/singers to) and a `code` (short, human-typeable join code, phone/QR). Deliberately minimal and foundational — creates a room and looks one up by code; per-room playback/queue/singer scoping builds ON this table being real. Kept out of $lib/contract on purpose: the wire contract carries no Room today, and room work is scoped not to cross the shared package boundary.

import { randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { DB } from '../db/index';
import { rooms } from '../db/schema';
import { ulid, CODE_ALPHABET, CODE_LENGTH } from '../../contract';

// The join-code vocabulary lives in $lib/contract/room-code, so the phone's six-segment entry rejects exactly the characters this server rejects, with no second copy to drift.

/** A persisted room. Shape mirrors the `rooms` table row. */
export interface Room {
	id: string;
	code: string;
	createdAt: number;
}

/** Mint a random join code over {@link CODE_ALPHABET}. */
export function mintRoomCode(): string {
	const bytes = randomBytes(CODE_LENGTH);
	let code = '';
	for (let i = 0; i < CODE_LENGTH; i++) {
		code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
	}
	return code;
}

/** The public room columns: the seat holder stays off every {@link Room}, since only the TV seat reads it. */
const ROOM = { id: rooms.id, code: rooms.code, createdAt: rooms.createdAt };

export class RoomRepository {
	#db: DB;
	constructor(db: DB) {
		this.#db = db;
	}

	/** Create a room, minting an `id` and a unique join `code`. Retries on a code collision (the `rooms_code_idx` unique constraint) so the caller always gets a room whose code is genuinely free; throws only after exhausting retries, since a persistent failure there is a bug, not a normal path. `mintCode` is injectable so the retry branch is deterministically testable. */
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
				// A UNIQUE violation on the code means we drew a code already in use: draw again. Anything else is a real error and should surface immediately.
				if (!isUniqueViolation(err)) throw err;
				lastErr = err;
			}
		}
		throw new Error(`could not mint a free room code after ${attempts} attempts`, { cause: lastErr });
	}

	/** The single active party for this core: boot mints exactly one room (the identity phones join and the QR advertises), so this returns it, minting one on first boot. A caller wanting a SPECIFIC room resolves by code instead. Oldest-first so a box with multiple rows still resolves to the room it has been advertising, not a newer one after restart. */
	ensureActive(now: number): Room {
		const existing = this.#db.select(ROOM).from(rooms).orderBy(asc(rooms.createdAt)).all()[0];
		if (existing) return existing;
		return this.create(now);
	}

	/** Look a room up by its join code, or null if no room carries it. */
	byCode(code: string): Room | null {
		if (!code) return null;
		return this.#db.select(ROOM).from(rooms).where(eq(rooms.code, code)).all()[0] ?? null;
	}

	/** Look a room up by its internal id, or null. */
	byId(id: string): Room | null {
		if (!id) return null;
		return this.#db.select(ROOM).from(rooms).where(eq(rooms.id, id)).all()[0] ?? null;
	}

	/** The screen holding this room's TV seat, or null when it is free. See $lib/server/rooms/tv-seat. */
	tvSeat(id: string): string | null {
		return this.#db.select({ tvSeat: rooms.tvSeat }).from(rooms).where(eq(rooms.id, id)).all()[0]?.tvSeat ?? null;
	}

	setTvSeat(id: string, tvSeat: string | null): void {
		this.#db.update(rooms).set({ tvSeat }).where(eq(rooms.id, id)).run();
	}
}

/** True when the error is a SQLite UNIQUE constraint violation (bun:sqlite surfaces it in the message). */
function isUniqueViolation(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /UNIQUE constraint failed/i.test(msg);
}
