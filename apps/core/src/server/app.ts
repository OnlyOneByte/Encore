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
import { createPopularityTracker, type PopularityTracker } from './media/popularity';
import { JobRepository } from './jobs/repository';
import { JobReaper } from './jobs/reaper';
import { WorkerRegistry } from './jobs/registry';
import { WorkerHub } from './jobs/worker-hub';
import { reconcileOnReady } from './realtime/player';
import { resolveMediaStoreConfig, LocalMediaStore, type MediaStore, type MediaStoreConfig } from './media/store';
import { ObjectMediaStore, bunS3Client } from './media/object-store';
import type { ServerEvent, Media, WorkerCommand } from '@encore/shared';

export interface EncoreApp {
	db: DB;
	state: AuthoritativeState;
	singers: SingerRepository;
	jobs: JobRepository;
	reaper: JobReaper;
	workers: WorkerRegistry;
	workerHub: WorkerHub;
	mediaById: Map<string, Media>;
	localLibrary: LocalLibrary;
	youtube: YouTubeResolver;
	popularity: PopularityTracker;
	mediaStore: MediaStore; // local volume (default) or object-store (S3/MinIO) — MASTER-DESIGN §2
	mediaStoreConfig: MediaStoreConfig; // the resolved config sent to remote workers in worker:welcome
	publish: (e: ServerEvent) => void; // room broadcast; replaced by server.ts at boot
	/** Send a WorkerCommand to ONE worker session; replaced by server.ts with the real socket map. */
	toWorker: (workerId: string, cmd: WorkerCommand) => void;
	now: () => number;
}

/** Build the MediaStore (+ its wire config) from env. Object-store is lazy: the S3 client is only
 *  constructed when MEDIA_STORE=object resolves to a usable bucket; otherwise the local default. */
function buildMediaStore(): { store: MediaStore; config: MediaStoreConfig } {
	const config = resolveMediaStoreConfig(process.env);
	if (config.kind === 'object') {
		return { store: new ObjectMediaStore(bunS3Client(config), config), config };
	}
	return { store: new LocalMediaStore(), config };
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

	const jobs = new JobRepository(db);
	const workers = new WorkerRegistry();
	const mediaById = new Map<string, Media>();
	const { store: mediaStore, config: mediaStoreConfig } = buildMediaStore();

	// The app object is built below; the hub's sinks (toWorker/broadcast) read THROUGH the app so
	// server.ts can replace the real socket map at boot without rebuilding the hub.
	const app: EncoreApp = {
		db,
		state,
		singers: new SingerRepository(db),
		jobs,
		reaper: null as never, // set just below (needs onReaped → workerHub.dispatch)
		workers,
		workerHub: null as never, // set just below (needs app.toWorker/publish indirection)
		mediaById,
		localLibrary: new LocalLibrary(),
		youtube: new YouTubeResolver(ytDlpSearch),
		popularity: createPopularityTracker(),
		mediaStore,
		mediaStoreConfig,
		// no-op sinks until server.ts wires Bun.serve; routes/state still work without them
		publish: () => {},
		toWorker: () => {},
		now: () => Date.now()
	};

	app.workerHub = new WorkerHub({
		jobs,
		registry: workers,
		mediaById,
		toWorker: (workerId, cmd) => app.toWorker(workerId, cmd),
		broadcast: (e) => app.publish(e),
		// remote workers pull source / push stems via this store config (local volume or S3/MinIO)
		mediaStore: mediaStoreConfig,
		// When a cooked song flips to ready, reconcile playback (start if the room idled / preload) —
		// the held entry slots back at its fair position (M7-C6).
		onMediaReady: () =>
			reconcileOnReady({ state, publish: (e) => app.publish(e), mediaById }),
		now: () => app.now()
	});

	// When the reaper requeues/fails a job (lease expiry), capacity may have changed → redispatch.
	app.reaper = new JobReaper(jobs, { onReaped: () => app.workerHub.dispatch() });
	// Boot recovery (§3): a core restart drops every worker WS session, so any job still marked
	// assigned/running is orphaned — reset it to queued for redispatch. One-shot, before the tick
	// loop (server.ts starts the loop). No-op on a fresh/in-memory DB.
	app.reaper.recoverOnBoot();

	g[APP_KEY] = app;
	return g[APP_KEY]!;
}

/** server.ts calls this at boot to route broadcasts through Bun.serve's native pub/sub. */
export function setPublish(fn: (e: ServerEvent) => void): void {
	getApp().publish = fn;
}
