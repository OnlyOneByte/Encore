// Shared runtime singleton — the seam between SvelteKit `+server.ts` API routes and the
// Bun.serve WS hub. In production both run in ONE Bun process (MASTER-DESIGN §2), so a
// module-level singleton is the correct, simplest wiring: routes mutate authoritative state
// and call app.publish(); server.ts injects the real Bun.serve publish at boot.

import { AuthoritativeState } from './state/store';
import { SingerRepository } from './singers/repository';
import { openDb, defaultDbPath, type DB } from './db/index';
import { runMigrations, hydrate } from './db/migrate';
import { sqlitePersistence } from './state/persistence';
import type { ServerEvent, Media } from '@encore/shared';

export interface EncoreApp {
	db: DB;
	state: AuthoritativeState;
	singers: SingerRepository;
	mediaById: Map<string, Media>;
	publish: (e: ServerEvent) => void; // room broadcast; replaced by server.ts at boot
	now: () => number;
}

let _app: EncoreApp | null = null;

/** Build (once) the shared app. Idempotent — repeated calls return the same instance. */
export function getApp(): EncoreApp {
	if (_app) return _app;

	const dbPath = process.env.DATA_DIR ? defaultDbPath() : ':memory:';
	const { db } = openDb(dbPath);
	runMigrations(db, './drizzle');

	const state = new AuthoritativeState(sqlitePersistence(db));
	const { entries, playback } = hydrate(db);
	state.hydrate(entries, playback);

	_app = {
		db,
		state,
		singers: new SingerRepository(db),
		mediaById: new Map(),
		// no-op until server.ts wires Bun.serve's publish; routes still work (state mutates)
		publish: () => {},
		now: () => Date.now()
	};
	return _app;
}

/** server.ts calls this at boot to route broadcasts through Bun.serve's native pub/sub. */
export function setPublish(fn: (e: ServerEvent) => void): void {
	getApp().publish = fn;
}
