// Canonical in-memory test database. Every server test spun up its own db + migration by hand,
// in three drifting spellings: `openDb(':memory:') + runMigrations` (most), and two raw
// `drizzle(new Database(':memory:'))` variants that pinned `migrationsFolder` to a hardcoded
// `../../../drizzle` URL — bypassing findMigrationsDir()'s journal-walk and ENCORE_MIGRATIONS_DIR
// override, and skipping openDb()'s pragmas (WAL, foreign_keys=ON, busy_timeout). A migration or
// pragma added on one path silently skipped the others. This is the single source: it opens the
// same way production does and runs the same migration entry point, so there is one path to keep
// correct. See issue #618 / #455.
import { openDb } from './index';
import { runMigrations } from './migrate';
import type { DB } from './index';

/** A fresh, fully-migrated in-memory Drizzle handle with the same pragmas production opens with. */
export function migratedDb(): DB {
	const { db } = openDb(':memory:');
	runMigrations(db);
	return db;
}
