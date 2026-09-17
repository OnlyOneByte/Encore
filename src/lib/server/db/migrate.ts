// Apply migrations programmatically at boot (no separate migrate step in the container).
// Also exposes hydrate(): the boot-time read that seeds in-memory authoritative state.

import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './index';
import { eq } from 'drizzle-orm';
import { queueEntries, playbackState } from './schema';

/**
 * Locate drizzle without depending on the CWD. A hardcoded './drizzle' meant every
 * caller only worked when launched from . — `bun test` from the repo root died with
 * "Can't find meta/_journal.json". Walk up from this module (source tree AND bundled output land
 * some fixed number of dirs under .) until we see the journal. ENCORE_MIGRATIONS_DIR
 * overrides for anyone relocating the folder.
 */
/**
 * This module's own directory, derived the one way that holds in BOTH runtimes it loads under.
 *
 * `import.meta.dir` is BUN-ONLY, and that made this function throw under vite. `bun run dev` (which
 * `dev.sh --ui` execs, and which the script itself documents as the UI-HMR path) serves the app through
 * vite's SSR transform, and that transform hands each module its own `import.meta` carrying `url` and
 * NOT `dir`. So `dir` was `undefined`, `join(undefined, 'drizzle')` threw
 * `The "paths[0]" property must be of type string`, and `runMigrations` — reached from `getApp()` —
 * took EVERY DB-backed route with it: /settings 500, plus /api/me, /api/library, /api/metrics and
 * /api/stats. `bun run start` was unaffected because Bun defines `import.meta.dir`, which is exactly
 * why this stayed invisible: the built server, the container and `bun test` all pass.
 *
 * `import.meta.url` is specified rather than runtime-specific and is present in both, so it is what
 * this derives from. Keep it that way — a second Bun-only `import.meta` field would restore the bug.
 */
function moduleDir(): string {
	return dirname(fileURLToPath(import.meta.url));
}

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

/**
 * Boot-hydrate: read durable queue + playback rows back on startup for the state module to seed
 * the authoritative in-memory representation.
 */
export function hydrate(
	db: DB,
	roomId: string
): {
	entries: (typeof queueEntries.$inferSelect)[];
	playback: typeof playbackState.$inferSelect | null;
} {
	// The queue is keyed by room now: read only THIS room's entries, not the whole deployment.
	// Without the filter a boot would hydrate every room's queue into one room's authoritative store.
	const entries = db.select().from(queueEntries).where(eq(queueEntries.roomId, roomId)).all();
	// Playback is keyed by room now: read THIS room's row, not whichever came back first. A
	// room that has never played has no row yet, so null (the caller seeds boot defaults) is normal.
	const playback = db.select().from(playbackState).where(eq(playbackState.roomId, roomId)).all()[0] ?? null;
	return { entries, playback };
}
