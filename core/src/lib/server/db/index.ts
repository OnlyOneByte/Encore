// bun:sqlite + Drizzle client. WAL mode (concurrent reads + a single writer) suits this model: reads come from in-memory state, writes are write-behind. See ARCHITECTURE §9.

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema';

export type DB = ReturnType<typeof drizzle<typeof schema>>;

/** Open (or create) a bun:sqlite database with WAL + sane pragmas, return a Drizzle handle. */
export function openDb(path: string): { db: DB; sqlite: Database } {
	// `create: true` makes the FILE but not its parent dir — a fresh clone with no pre-made ./data dies with SQLITE_CANTOPEN (Docker hides it: compose bind-mounts ./data). `:memory:` has no dir to make.
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const sqlite = new Database(path, { create: true });
	sqlite.exec('PRAGMA journal_mode = WAL;');
	sqlite.exec('PRAGMA foreign_keys = ON;');
	sqlite.exec('PRAGMA busy_timeout = 5000;');
	const db = drizzle(sqlite, { schema });
	return { db, sqlite };
}

/** Core's own state dir: the database lives here. */
export function dataDir(): string {
	return process.env.DATA_DIR ?? './data';
}

export const DB_FILE = 'encore.sqlite';

/** Default app DB path (overridable for tests / env). */
export function defaultDbPath(): string {
	return `${dataDir()}/${DB_FILE}`;
}

export { schema };
