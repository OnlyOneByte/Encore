// Apply migrations programmatically at boot (no separate migrate step in the container).
// Also exposes hydrate(): the boot-time read that seeds in-memory authoritative state.

import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DB } from './index';
import { queueEntries, playbackState } from './schema';

/**
 * Locate apps/core/drizzle without depending on the CWD. A hardcoded './drizzle' meant every
 * caller only worked when launched from apps/core — `bun test` from the repo root died with
 * "Can't find meta/_journal.json". Walk up from this module (source tree AND bundled output land
 * some fixed number of dirs under apps/core) until we see the journal. ENCORE_MIGRATIONS_DIR
 * overrides for anyone relocating the folder.
 */
function findMigrationsDir(): string {
	const override = process.env.ENCORE_MIGRATIONS_DIR;
	if (override) return override;
	let dir = import.meta.dir;
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, 'drizzle');
		if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return resolve('./drizzle'); // last resort: the old CWD-relative behaviour
}

/** Run pending migrations. Idempotent (drizzle tracks applied migrations). */
export function runMigrations(db: DB, migrationsFolder = findMigrationsDir()): void {
	migrate(db, { migrationsFolder });
}

/**
 * Boot-hydrate: read durable queue + playback rows back on startup for the state module to seed
 * the authoritative in-memory representation.
 */
export function hydrate(db: DB): {
	entries: (typeof queueEntries.$inferSelect)[];
	playback: typeof playbackState.$inferSelect | null;
} {
	const entries = db.select().from(queueEntries).all();
	const playback = db.select().from(playbackState).all()[0] ?? null;
	return { entries, playback };
}
