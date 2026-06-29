// bun:sqlite + Drizzle client. WAL mode (concurrent reads + a single writer) is ideal for
// our model: reads come from in-memory state, writes are write-behind. See MASTER-DESIGN §2a.

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

export type DB = ReturnType<typeof drizzle<typeof schema>>;

/** Open (or create) a bun:sqlite database with WAL + sane pragmas, return a Drizzle handle. */
export function openDb(path: string): { db: DB; sqlite: Database } {
	const sqlite = new Database(path, { create: true });
	sqlite.exec('PRAGMA journal_mode = WAL;');
	sqlite.exec('PRAGMA foreign_keys = ON;');
	sqlite.exec('PRAGMA busy_timeout = 5000;');
	const db = drizzle(sqlite, { schema });
	return { db, sqlite };
}

/** Default app DB path (overridable for tests / env). */
export function defaultDbPath(): string {
	const dir = process.env.DATA_DIR ?? './data';
	return `${dir}/encore.sqlite`;
}

export { schema };
