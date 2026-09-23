// Apply migrations programmatically at boot (no separate migrate step in the container).
// Also exposes hydrate(): the boot-time read that seeds in-memory authoritative state.

import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './index';
import { eq } from 'drizzle-orm';
import { queueEntries, playbackState } from './schema';

/** This module's own directory, derived the one way that holds in BOTH runtimes it loads under. `import.meta.dir` is BUN-ONLY and undefined under vite's SSR transform (the `bun run dev` / --ui path), which broke every DB-backed route when this used it. `import.meta.url` is present in both, so it is what this derives from — a second Bun-only `import.meta` field here would reintroduce the bug. */
function moduleDir(): string {
	return dirname(fileURLToPath(import.meta.url));
}

/** Locate drizzle without depending on the CWD — a hardcoded './drizzle' only worked when launched from `.`, breaking `bun test` from the repo root. Walks up from this module until it finds the journal; ENCORE_MIGRATIONS_DIR overrides for a relocated folder. */
function findMigrationsDir(): string {
	const override = process.env.ENCORE_MIGRATIONS_DIR;
	if (override) return override;
	let dir = moduleDir();
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

/** Boot-hydrate: read durable queue + playback rows back on startup for the state module to seed the
 *  authoritative in-memory representation. */
export function hydrate(
	db: DB,
	roomId: string
): {
	entries: (typeof queueEntries.$inferSelect)[];
	playback: typeof playbackState.$inferSelect | null;
} {
	// Queue is keyed by room: read only THIS room's entries, or boot would hydrate every room's queue
	// into one room's authoritative store.
	const entries = db.select().from(queueEntries).where(eq(queueEntries.roomId, roomId)).all();
	// Playback is keyed by room: read THIS room's row. A room that has never played has no row yet, so
	// null (the caller seeds boot defaults) is normal.
	const playback = db.select().from(playbackState).where(eq(playbackState.roomId, roomId)).all()[0] ?? null;
	return { entries, playback };
}
