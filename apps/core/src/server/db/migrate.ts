// Apply migrations programmatically at boot (no separate migrate step in the container).
// Also exposes hydrate(): the boot-time read that seeds in-memory authoritative state (M1-C1).

import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import type { DB } from './index';
import { queueEntries, playbackState } from './schema';

/** Run pending migrations from ./drizzle. Idempotent (drizzle tracks applied migrations). */
export function runMigrations(db: DB, migrationsFolder = './drizzle'): void {
	migrate(db, { migrationsFolder });
}

/**
 * Boot-hydrate: read durable state back into memory on startup. M1-C1 will consume this to
 * seed the authoritative in-memory queue + playback. Returns the rows; the state module owns
 * the in-memory representation.
 */
export function hydrate(db: DB): {
	entries: (typeof queueEntries.$inferSelect)[];
	playback: typeof playbackState.$inferSelect | null;
} {
	const entries = db.select().from(queueEntries).all();
	const playback = db.select().from(playbackState).all()[0] ?? null;
	return { entries, playback };
}
