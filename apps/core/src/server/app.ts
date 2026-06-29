// Shared runtime singleton — the seam between SvelteKit `+server.ts` API routes and the
// Bun.serve WS hub. In production both run in ONE Bun process (MASTER-DESIGN §2), so a
// module-level singleton is the correct, simplest wiring: routes mutate authoritative state
// and call app.publish(); server.ts injects the real Bun.serve publish at boot.

import { AuthoritativeState } from './state/store';
import { SingerRepository } from './singers/repository';
import { openDb, defaultDbPath, type DB } from './db/index';
import { runMigrations, hydrate } from './db/migrate';
import { sqlitePersistence } from './state/persistence';
import { LocalLibrary } from './media/local';
import { YouTubeResolver } from './media/youtube';
import { ytDlpSearch } from './media/ytdlp';
import type { ServerEvent, Media } from '@encore/shared';

export interface EncoreApp {
	db: DB;
	state: AuthoritativeState;
	singers: SingerRepository;
	mediaById: Map<string, Media>;
	localLibrary: LocalLibrary;
	youtube: YouTubeResolver;
	publish: (e: ServerEvent) => void; // room broadcast; replaced by server.ts at boot
	now: () => number;
}

// CRITICAL: the SvelteKit prod handler is a SEPARATE bundle from server.ts, so a module-level
// `let _app` would give each module graph its own instance (split-brain state; separate :memory:
// DBs in dev). Backing the singleton on globalThis guarantees ONE shared instance across both.
const APP_KEY = Symbol.for('encore.app');
type GlobalWithApp = typeof globalThis & { [APP_KEY]?: EncoreApp };

/** Build (once) the shared app. Idempotent — repeated calls return the same instance. */
export function getApp(): EncoreApp {
	const g = globalThis as GlobalWithApp;
	if (g[APP_KEY]) return g[APP_KEY];

	const dbPath = process.env.DATA_DIR ? defaultDbPath() : ':memory:';
	const { db } = openDb(dbPath);
	runMigrations(db, './drizzle');

	const state = new AuthoritativeState(sqlitePersistence(db));
	const { entries, playback } = hydrate(db);
	state.hydrate(entries, playback);

	g[APP_KEY] = {
		db,
		state,
		singers: new SingerRepository(db),
		mediaById: new Map(),
		localLibrary: new LocalLibrary(),
		youtube: new YouTubeResolver(ytDlpSearch),
		// no-op until server.ts wires Bun.serve's publish; routes still work (state mutates)
		publish: () => {},
		now: () => Date.now()
	};
	return g[APP_KEY]!;
}

/** server.ts calls this at boot to route broadcasts through Bun.serve's native pub/sub. */
export function setPublish(fn: (e: ServerEvent) => void): void {
	getApp().publish = fn;
}
