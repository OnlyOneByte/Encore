// Shared runtime singleton — the seam between SvelteKit `+server.ts` API routes and the
// Bun.serve WS hub. In production both run in ONE Bun process (MASTER-DESIGN §2), so a
// module-level singleton is the correct, simplest wiring: routes mutate authoritative state
// and call app.publish(); server.ts injects the real Bun.serve publish at boot.

import { AuthoritativeState } from './state/store';
import { SingerRepository } from './singers/repository';
import { PresenceTracker } from './realtime/presence';
import { openDb, defaultDbPath, type DB } from './db/index';
import { runMigrations, hydrate } from './db/migrate';
import { sqlitePersistence } from './state/persistence';
import { LocalLibrary } from './media/local';
import { YouTubeResolver } from './media/youtube';
import { ytDlpSearch } from './media/ytdlp';
import { MediaRepository, hydrateMediaCatalog } from './media/repository';
import { migrateStorageLayout } from './media/migrate-layout';
import { readSidecar, writeSidecar, sidecarFromMedia, rebuildIndexFromMeta, backfillSidecars, browseArtist, readAllSidecars } from './media/sidecar';
import { media as mediaTable } from './db/schema';
import { eq } from 'drizzle-orm';
import { createPopularityTracker, type PopularityTracker } from './media/popularity';
import { JobRepository } from './jobs/repository';
import { JobReaper } from './jobs/reaper';
import { WorkerRegistry } from './jobs/registry';
import { WorkerHub } from './jobs/worker-hub';
import { reconcileOnReady } from './realtime/player';
import { syncEvent } from './realtime/hub';
import { resolveMediaStoreConfig, LocalMediaStore, type MediaStore, type MediaStoreConfig } from './media/store';
import { ObjectMediaStore, bunS3Client } from './media/object-store';
import type { ServerEvent, Media, WorkerCommand } from '@encore/shared';

export interface EncoreApp {
	db: DB;
	state: AuthoritativeState;
	singers: SingerRepository;
	/** Who holds a live socket right now (B-6-C1). Populated by server.ts's WS open/close. */
	presence: PresenceTracker;
	jobs: JobRepository;
	reaper: JobReaper;
	workers: WorkerRegistry;
	workerHub: WorkerHub;
	mediaById: Map<string, Media>;
	/** Durable media catalog (B-1): write-behind store behind `mediaById` + the saved-karaoke library. */
	media: MediaRepository;
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

	// Persist to a file-backed SQLite DB by default (singers, queue, playback survive restarts —
	// a party server that forgot everyone on restart is a bug, not a feature). DATA_DIR overrides
	// the location (defaults to ./data). Set ENCORE_EPHEMERAL=1 for a throwaway in-memory DB.
	const dbPath = process.env.ENCORE_EPHEMERAL === '1' ? ':memory:' : defaultDbPath();
	const { db } = openDb(dbPath);
	runMigrations(db, './drizzle');

	// B-7-C2: bring the media volume onto the storage classes BEFORE anything reads the catalog.
	// Idempotent — a no-op on a fresh or already-migrated volume — so it stays wired in permanently.
	// The raw original is PROMOTED out of the old scratch dir rather than deleted with it; DB refs are
	// rewritten in the same pass so instrumentalRef/pitchRef/lyricsRef keep pointing at real files.
	//
	// WRAPPED, and deliberately so: storage housekeeping must NEVER stop the party server from
	// booting. The first real run of this crashed startup on an EACCES, because the old scratch dir
	// was owned by the worker container's uid. A karaoke box that will not start because it could not
	// tidy a directory is a far worse failure than a volume that stays on the old layout.
	try {
		const layout = migrateStorageLayout((mediaId, fields) => {
			const sets: Partial<Record<'instrumentalRef' | 'pitchRef' | 'lyricsRef', string>> = {};
			if (fields.instrumentalRef) sets.instrumentalRef = fields.instrumentalRef;
			if (fields.pitchRef) sets.pitchRef = fields.pitchRef;
			if (fields.lyricsRef) sets.lyricsRef = fields.lyricsRef;
			if (Object.keys(sets).length) db.update(mediaTable).set(sets).where(eq(mediaTable.id, mediaId)).run();
		});
		if (!layout.alreadyMigrated && (layout.moved > 0 || layout.failed > 0)) {
			console.log(
				`[core] storage layout: ${layout.moved} files (${(layout.bytesMoved / 1e6).toFixed(1)} MB) moved, ` +
					`${layout.refsRewritten} media refs rewritten, ${layout.pruned} legacy dirs pruned` +
					(layout.copiedInPlace ? `, ${layout.copiedInPlace} copied (source not removable)` : '') +
					(layout.skipped ? `, ${layout.skipped} skipped` : '') +
					(layout.failed ? `, ${layout.failed} FAILED` : '')
			);
			for (const f of layout.failures.slice(0, 5)) console.warn(`[core] storage layout could not move ${f.from}: ${f.reason}`);
		}
	} catch (err) {
		console.warn(`[core] storage layout migration skipped: ${(err as Error).message} — running on the existing layout`);
	}

	const state = new AuthoritativeState(sqlitePersistence(db));
	const { entries, playback } = hydrate(db);
	state.hydrate(entries, playback);

	const jobs = new JobRepository(db);
	const workers = new WorkerRegistry();
	const mediaById = new Map<string, Media>();
	const { store: mediaStore, config: mediaStoreConfig } = buildMediaStore();

	// B-1: hydrate the runtime catalog from the durable store BEFORE anything reads it. Without this
	// a restart forgot every song title (a hydrated queue entry rendered as a raw id) and re-cooked
	// songs whose stems were already sitting on disk.
	// B-7-C3: the DB is an INDEX over the sidecars, so every persist refreshes meta/<id>.json, and a
	// sidecar present on disk but missing from the index is restored below. Together those give the
	// volume the property that matters: it describes itself, so losing the SQLite file costs an
	// index rebuild rather than every title and artifact link.
	// eslint-disable-next-line prefer-const -- the persist callback closes over this, and only ever runs
	// after an await, so the binding is initialised by the time it is read.
	let mediaRepo: MediaRepository;
	mediaRepo = new MediaRepository(db, (m) => {
		void (async () => {
			try {
				const prev = await readSidecar(m.id);
				const next = sidecarFromMedia(m, Date.now(), prev);
				await writeSidecar(next);
				// B-7-C4: mirror the sidecar's canonical metadata into the INDEX so browse can group by
				// it. `browseArtist` returns null for a low-confidence parse, so an uncertain guess is
				// stored as NULL rather than becoming a library heading that is simply wrong.
				mediaRepo.setCanonical(m.id, { artist: browseArtist(next), album: next.canonical.album, year: next.canonical.year });
				mediaRepo.setTags(m.id, 'genre', next.canonical.genre);
				if (next.library.tags.length) mediaRepo.setTags(m.id, 'tag', next.library.tags);
			} catch {
				/* the sidecar is the durable record, not the live one — never fail a flip over it */
			}
		})();
	});
	hydrateMediaCatalog(mediaRepo.all(), mediaById);

	// Restore anything the sidecars know about that the index does not. This is what makes the media
	// volume portable: drop it on a new box (or delete the SQLite file) and the library comes back.
	// Async and non-blocking — boot must not wait on a directory scan, and a party server that will
	// not start because a rescan is slow is the worse failure.
	void rebuildIndexFromMeta({
		hasMedia: (id) => mediaById.has(id),
		upsert: (m) => {
			mediaById.set(m.id, m);
			mediaRepo.upsert(m);
		}
	})
		.then(async (restored) => {
			if (restored > 0) console.log(`[core] restored ${restored} media from sidecars in meta/`);
			// And the other direction: describe every song the index already knows. Without this the
			// portable-volume property would only apply to songs added AFTER B-7-C3.
			const written = await backfillSidecars(mediaRepo.all(), Date.now());
			if (written > 0) console.log(`[core] backfilled ${written} sidecars into meta/`);

			// B-7-C4: mirror canonical artist/album/year + genres from every sidecar into the browse
			// index. Needed as its own pass because backfilling a sidecar does not go through upsert,
			// so without it browse would only see songs touched since the process started.
			let indexed = 0;
			for (const s of await readAllSidecars()) {
				mediaRepo.setCanonical(s.id, { artist: browseArtist(s), album: s.canonical.album, year: s.canonical.year });
				if (s.canonical.genre.length) mediaRepo.setTags(s.id, 'genre', s.canonical.genre);
				indexed++;
			}
			if (indexed > 0) console.log(`[core] browse index synced from ${indexed} sidecars`);
		})
		.catch(() => {
			/* best effort — the DB index is still authoritative enough to run a party */
		});

	// The app object is built below; the hub's sinks (toWorker/broadcast) read THROUGH the app so
	// server.ts can replace the real socket map at boot without rebuilding the hub.
	const app: EncoreApp = {
		db,
		state,
		singers: new SingerRepository(db),
		presence: new PresenceTracker(),
		jobs,
		reaper: null as never, // set just below (needs onReaped → workerHub.dispatch)
		workers,
		workerHub: null as never, // set just below (needs app.toWorker/publish indirection)
		mediaById,
		media: mediaRepo,
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
		// B-1: a cooked song is durable — persist the ready flip (instrumental key + lyrics + pitch)
		// so the next boot lists it in the karaoke library instead of re-cooking it.
		persistMedia: (mediaId) => {
			const m = mediaById.get(mediaId);
			if (m) mediaRepo.upsert(m);
		},
		// When a cooked song flips to ready, reconcile playback (start if the room idled / preload) —
		// the held entry slots back at its fair position (M7-C6). Broadcast a fresh queue:sync FIRST
		// so every client updates its media catalog with the now-ready song's new sourceRef (the
		// instrumental key) + ready status — otherwise the TV's cached media stays 'queued' and sits
		// on the WAITING screen (the "big gap" between cook-finish and playback) until a later sync.
		onMediaReady: () => {
			app.publish(syncEvent(state, { mediaById, listSingers: () => app.singers.listPublic(), listOnline: () => app.presence.online() }));
			reconcileOnReady({ state, publish: (e) => app.publish(e), mediaById });
		},
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
