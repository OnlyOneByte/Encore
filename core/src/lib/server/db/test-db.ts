// Canonical in-memory test database: the SINGLE source, opening the same way production does
// (openDb's pragmas) and running the same migration entry point (runMigrations/findMigrationsDir), so
// a migration or pragma change can't silently skip a test path that re-implemented its own DB setup.
import { openDb } from './index';
import { runMigrations } from './migrate';
import type { DB } from './index';

/** A fresh, fully-migrated in-memory Drizzle handle with the same pragmas production opens with. */
export function migratedDb(): DB {
	const { db } = openDb(':memory:');
	runMigrations(db);
	return db;
}
