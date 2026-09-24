// The seam between SvelteKit routes and the WS hub, which share ONE Bun process, so this module-level instance is deliberately the single source of truth. See docs/SERVER.md#authority-and-the-hub.

import { AuthoritativeState } from './state/store';
import { SingerRepository } from './singers/repository';
import { RoomRepository } from './rooms/repository';
import { PresenceTracker } from './realtime/presence';
import { PlayTracker, bumpPlay } from './media/plays';
import { openDb, defaultDbPath, type DB } from './db/index';
import { runMigrations, hydrate } from './db/migrate';
import { sqlitePersistence } from './state/persistence';
import { SettingsRepository } from './state/settings-repository';
import { LocalLibrary } from './media/local';
import { YouTubeResolver } from './media/youtube';
import { SpotifyResolver } from './media/spotify-resolver';
import { spotifySearch } from './media/spotify';
import { ytDlpSearch } from './media/ytdlp';
import { MediaRepository, hydrateMediaCatalog } from './media/repository';
import { migrateStorageLayout } from './media/migrate-layout';
import {
	retentionCapBytes,
	planRecompress,
	recompressLegacyStems,
	ffmpegTranscoder,
	planEviction,
	evictDerived,
	derivedBytesOf,
	transcodeDiagnostics
} from './media/retention';
import { needsLyricsBackfill, BACKFILL_PRIORITY } from './jobs/backfill';
import { backfillVocalsRefs } from './media/vocals-backfill';
import { ffmpegLoudnessProbe, isDigitalSilence } from './media/loudness';
import { safeMediaPath } from './media/local-files';
import { guideMixKey } from './media/paths';
import { existsSync, rmSync } from 'node:fs';

import { markLyricsQueued, reportTerminalFailure } from './jobs/process';
import { reconcileStrandedGates } from './jobs/gate-reconcile';
import { cancelJobsForMedia } from './jobs/cancel';
import { reprioritizeProcessForMedia } from './jobs/reprioritize-process';
import {
	readSidecar,
	writeSidecar,
	sidecarFromMedia,
	rebuildIndexFromMeta,
	backfillSidecars,
	browseArtist,
	lookupTitle,
	readAllSidecars,
	clearArtifacts,
	type MediaSidecar
} from './media/sidecar';
import { media as mediaTable } from './db/schema';
import { eq } from 'drizzle-orm';
import { createPopularityTracker, type PopularityTracker } from './media/popularity';
import { JobRepository } from './jobs/repository';
import { AttemptLedger } from './jobs/attempts';
import { PlayLog } from './media/play-log';
import { JobReaper } from './jobs/reaper';
import { WorkerRegistry } from './jobs/registry';
import { WorkerHub } from './jobs/worker-hub';
import { runBootMaintenance, type BootTask } from './boot-maintenance';
import { reconcileOnReady } from './realtime/player';
import { orderingOf, syncEvent, type HubDeps, type Publish } from './realtime/hub';
import { resolveMediaStoreConfig, LocalMediaStore, type MediaStore, type MediaStoreConfig } from './media/store';
import { ObjectMediaStore, bunS3Client } from './media/object-store';
import type { ServerEvent, Media, WorkerCommand, QueueEntry } from '../contract';

export interface EncoreApp {
	db: DB;
	state: AuthoritativeState;
	singers: SingerRepository;
	rooms: RoomRepository;
	/** Where a bare `/join` lands, and the room the TV QR advertises; an explicit code resolves via {@link rooms}. */
	activeRoomId: string;
	presence: PresenceTracker;
	/** Retention's LRU recency signal. Wire `app.plays.onNowPlaying` at EVERY HubDeps.onNowPlaying site. */
	plays: PlayTracker;
	jobs: JobRepository;
	attempts: AttemptLedger;
	/** One row per performance — the time axis a play COUNTER cannot provide. */
	playLog: PlayLog;
	settings: SettingsRepository;
	reaper: JobReaper;
	workers: WorkerRegistry;
	workerHub: WorkerHub;
	mediaById: Map<string, Media>;
	/** Durable media catalog: write-behind store behind `mediaById` + the saved-karaoke library. */
	media: MediaRepository;
	localLibrary: LocalLibrary;
	youtube: YouTubeResolver;
	/** Spotify SEARCH / metadata source (annotator only; no acquisition). No-op when creds unset. */
	spotify: SpotifyResolver;
	popularity: PopularityTracker;
	mediaStore: MediaStore; // local volume (default) or object-store (S3/MinIO)
	mediaStoreConfig: MediaStoreConfig; // the resolved config sent to remote workers in worker:welcome
	publish: (e: ServerEvent) => void; // room broadcast; replaced by server.ts at boot
	/** Replaced by server.ts with the real socket map. */
	toWorker: (workerId: string, cmd: WorkerCommand) => void;
	now: () => number;
}

/** Object-store is LAZY: the S3 client is constructed only once MEDIA_STORE=object resolves to a usable bucket. */
function buildMediaStore(): { store: MediaStore; config: MediaStoreConfig } {
	const config = resolveMediaStoreConfig(process.env);
	if (config.kind === 'object') {
		return { store: new ObjectMediaStore(bunS3Client(config), config), config };
	}
	return { store: new LocalMediaStore(), config };
}

/** The browse index's view of one sidecar, named ONCE so the live-persist callback and the boot sync pass
 *  cannot drift. browseArtist/lookupTitle return null on a low-confidence parse, so a guess never becomes a
 *  library heading. */
function canonicalsOf(s: MediaSidecar): {
	artist: string | null;
	title: string | null;
	album: string | null;
	year: number | null;
} {
	return { artist: browseArtist(s), title: lookupTitle(s), album: s.canonical.album, year: s.canonical.year };
}

// SvelteKit's prod bundle is a SEPARATE module graph from server.ts's, so a module-level `let _app` gives each its own instance (split-brain state). globalThis is what guarantees ONE across both.
const APP_KEY = Symbol.for('encore.app');
type GlobalWithApp = typeof globalThis & { [APP_KEY]?: EncoreApp };

/** Idempotent — repeated calls return the same instance. */
export function getApp(): EncoreApp {
	const g = globalThis as GlobalWithApp;
	if (g[APP_KEY]) return g[APP_KEY];

	// File-backed by default, so singers/queue/playback survive a restart. ENCORE_EPHEMERAL=1 forces :memory:.
	const dbPath = process.env.ENCORE_EPHEMERAL === '1' ? ':memory:' : defaultDbPath();
	const { db } = openDb(dbPath);
	runMigrations(db);

	// BEFORE anything reads the catalog, and idempotent. WRAPPED because storage housekeeping must never stop the server booting: a box that will not start over an untidy directory is worse than the old layout.
	try {
		const layout = migrateStorageLayout((mediaId, fields) => {
			const sets: Partial<Record<'instrumentalRef' | 'lyricsRef', string>> = {};
			if (fields.instrumentalRef) sets.instrumentalRef = fields.instrumentalRef;
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
			for (const f of layout.failures.slice(0, 5))
				console.warn(`[core] storage layout could not move ${f.from}: ${f.reason}`);
		}
	} catch (err) {
		console.warn(`[core] storage layout migration skipped: ${(err as Error).message} — running on the existing layout`);
	}

	// Settings BEFORE authoritative state: state's ordering reads settings live via a getter, since the room can change algorithm mid-party.
	const settings = new SettingsRepository(db);
	const singers = new SingerRepository(db);
	const rooms = new RoomRepository(db);
	// Minted on first boot, reused after — gives the QR a code and a bare `/join` a room.
	const activeRoomId = rooms.ensureActive(Date.now()).id;
	const state = new AuthoritativeState(sqlitePersistence(db, activeRoomId), 250, () =>
		orderingOf({
			getSettings: () => settings.getEffective(activeRoomId),
			listSingers: () => singers.listPublic(activeRoomId)
		})
	);
	const { entries, playback } = hydrate(db, activeRoomId);
	state.hydrate(entries, playback);

	// Jobs' historical half: `jobs` overwrites one row in place, so every past duration would otherwise be lost.
	const attempts = new AttemptLedger(db);
	const playLog = new PlayLog(db);
	const jobs = new JobRepository(db, attempts);
	// First boot ONLY: writing it every boot would stomp whatever the room later chose on the phone.
	const introEnv = process.env.ENCORE_SONG_INTRO_MS ?? process.env.INTERSTITIAL_MS;
	if (introEnv !== undefined && !settings.hasRoom(activeRoomId)) {
		const ms = Math.max(0, Number(introEnv));
		settings.setRoom(
			Number.isFinite(ms) && ms === 0 ? { songIntroEnabled: false } : { songIntroEnabled: true, songIntroMs: ms },
			activeRoomId
		);
	}
	const workers = new WorkerRegistry();
	const mediaById = new Map<string, Media>();
	const { store: mediaStore, config: mediaStoreConfig } = buildMediaStore();

	// BEFORE anything reads it, or a restart forgets every song title and re-processes songs whose stems are already on disk. The DB only INDEXES the sidecars, so losing the SQLite file costs a rebuild, not the library. The persist callback runs only after an await, so `mediaRepo` is initialised by the time it reads it.
	const mediaRepo = new MediaRepository(db, (m) => {
		void (async () => {
			try {
				const prev = await readSidecar(m.id);
				const next = sidecarFromMedia(m, Date.now(), prev);
				await writeSidecar(next);
				mediaRepo.setCanonical(m.id, canonicalsOf(next));
				if (next.library.tags.length) mediaRepo.setTags(m.id, 'tag', next.library.tags);
			} catch {
				/* the sidecar is the durable record, not the live one — never fail a flip over it */
			}
		})();
	});
	hydrateMediaCatalog(mediaRepo.all(), mediaById);

	// SYNCHRONOUS and BEFORE the party is serveable: a stranded song must never be OBSERVABLE as stranded, and deferring this hands the first /api/library load the exact row it repairs. Idempotent; wrapped as above.
	try {
		const recovered = reconcileStrandedGates(mediaById, {
			findLiveJob: (mediaId, jobType) => jobs.findLive(mediaId, jobType),
			persist: (m) => mediaRepo.upsert(m)
		});
		if (recovered.length > 0)
			console.log(
				`[core] settled ${recovered.length} stale readiness gate(s) with no live job: ${recovered.join(', ')}`
			);
	} catch (err) {
		console.warn(`[core] stale readiness-gate reconciliation skipped: ${(err as Error).message}`);
	}

	// Each pass is ISOLATED: one throwing must not skip the rest, and its failure must be NAMED rather than folded into one catch that cannot say which pass died.
	const bootTasks: BootTask[] = [
		{
			name: 'sidecar restore + backfill',
			run: async () => {
				// Both directions, which is what makes the volume portable: drop it on a new box, or delete the SQLite file, and the library comes back.
				const restored = await rebuildIndexFromMeta({
					hasMedia: (id) => mediaById.has(id),
					upsert: (m) => {
						mediaById.set(m.id, m);
						mediaRepo.upsert(m);
					}
				});
				if (restored > 0) console.log(`[core] restored ${restored} media from sidecars in meta/`);
				const written = await backfillSidecars(mediaRepo.all(), Date.now());
				if (written > 0) console.log(`[core] backfilled ${written} sidecars into meta/`);
			}
		},
		{
			name: 'browse index sync',
			run: async () => {
				// Its own pass because backfilling a sidecar does not go through upsert, so without it browse only sees songs touched since the process started.
				let indexed = 0;
				for (const sc of await readAllSidecars()) {
					const canonical = canonicalsOf(sc);
					mediaRepo.setCanonical(sc.id, canonical);
					// The RUNTIME map too, not just the index: hydrate ran synchronously while this pass is async, so DB-only mirroring leaves in-memory Media without canonicals for the process's life. Patch ONLY these fields — a wholesale replace undoes an entry that flipped to processing since hydrate.
					const live = mediaById.get(sc.id);
					if (live) {
						if (canonical.artist) live.artistCanonical = canonical.artist;
						if (canonical.title) live.titleCanonical = canonical.title;
					}
					indexed++;
				}
				if (indexed > 0) console.log(`[core] browse index synced from ${indexed} sidecars`);
			}
		},
		{
			name: 'guiding-track backfill',
			// Set ENCORE_VOCALS_BACKFILL=0 to skip.
			enabled: () => process.env.ENCORE_VOCALS_BACKFILL !== '0',
			run: async () => {
				// Pure filesystem work — nothing to queue, nothing competing with a live process. A silent stem is counted but deliberately NOT linked.
				const res = await backfillVocalsRefs(mediaById.values(), {
					resolve: (ref) => safeMediaPath(ref),
					exists: (abs) => existsSync(abs),
					measure: async (abs) => {
						const reading = await loudness(abs);
						if (!reading) return 'unknown'; // no ffmpeg — cannot judge, do not pretend to
						return isDigitalSilence(reading) ? 'silent' : 'audible';
					},
					link: (id, ref) => {
						// Runtime map AND the durable index: the first is what the player reads, the second survives a restart.
						const live = mediaById.get(id);
						if (!live) return;
						live.vocalsRef = ref;
						mediaRepo.upsert(live);
					}
				});
				if (res.linked > 0) console.log(`[core] guiding track: linked the vocals stem for ${res.linked} song(s)`);
				if (res.unmeasured > 0) {
					// Named separately from `linked`: trusted, not verified. Two causes an operator must tell apart — no ffmpeg on PATH, or a stripped build that cannot demux this format.
					console.log(
						`[core] guiding track: linked ${res.unmeasured} song(s) WITHOUT a loudness check —` +
							' no usable probe (ffmpeg missing, or a build with no AAC/FLAC demuxer).' +
							' Set FFMPEG_BIN to a full ffmpeg; until then a silent stem cannot be detected'
					);
				}
				if (res.silent > 0) {
					console.log(
						`[core] guiding track: ${res.silent} song(s) have a SILENT vocals stem — not linked, re-process to fix`
					);
				}
				if (res.missing > 0) {
					console.log(
						`[core] guiding track: ${res.missing} processed song(s) have no vocals stem on disk (re-process to add one)`
					);
				}
			}
		},
		{
			name: 'lyrics backfill',
			// Set ENCORE_LYRICS_BACKFILL=0 to skip (e.g. mid-party on a slow box).
			enabled: () => process.env.ENCORE_LYRICS_BACKFILL !== '0',
			run: async () => {
				// LOWEST priority, so a singer's live process always jumps the whole backfill queue; dedup on (mediaId, jobType) makes a restart idempotent.
				const need = needsLyricsBackfill(mediaById.values());
				for (const id of need) {
					jobs.enqueue(id, 'align', BACKFILL_PRIORITY, Date.now());
					markLyricsQueued(id, mediaById);
				}
				if (need.length > 0) {
					console.log(
						`[core] lyrics backfill: queued ${need.length} align job(s) for already-processed songs` +
							' (lowest priority; ENCORE_LYRICS_BACKFILL=0 to skip)'
					);
					app.workerHub.dispatch();
				}
			}
		},
		{
			name: 'recompress legacy stems',
			run: async () => {
				// In place, since the bytes are already here: no download and no Demucs run. Eviction is the wrong tool — it would drop those songs until re-processed.
				const targets = planRecompress(mediaRepo.all());
				if (targets.length === 0) return;
				const rc = await recompressLegacyStems(targets, ffmpegTranscoder());
				// Always report: converting NOTHING and failing everything must not look like having nothing to do.
				console.log(
					`[core] recompress: ${rc.converted}/${targets.length} legacy stems converted, ` +
						`${(rc.bytesBefore / 1e6).toFixed(1)} MB → ${(rc.bytesAfter / 1e6).toFixed(1)} MB ` +
						`(reclaimed ${((rc.bytesBefore - rc.bytesAfter) / 1e6).toFixed(1)} MB)` +
						(rc.skipped ? `, ${rc.skipped} skipped` : '') +
						(rc.failed ? `, ${rc.failed} FAILED — ${transcodeDiagnostics.lastError || 'ffmpeg unavailable'}` : '')
				);
				// Through upsert, so the sidecar follows.
				for (const [mediaId, ref] of rc.newRefs) {
					const live = mediaById.get(mediaId);
					if (live && live.instrumentalRef !== ref) {
						live.instrumentalRef = ref;
						mediaRepo.upsert(live);
					}
				}
			}
		},
		{
			name: 'derived eviction',
			// Unset by default — a party box must not silently delete.
			enabled: () => retentionCapBytes() !== null,
			run: async () => {
				// `audio/` and `meta/` are never candidates.
				const cap = retentionCapBytes();
				if (cap === null) return;
				const ready = mediaRepo.listReady();
				const candidates = ready.map((m) => ({ mediaId: m.id, derivedBytes: derivedBytesOf(m), lastUsedAt: 0 }));
				// Recency from the sidecar: lastPlayedAt, else addedAt for a never-played song.
				for (const c of candidates) {
					const side = await readSidecar(c.mediaId);
					c.lastUsedAt = side?.library.lastPlayedAt ?? side?.library.addedAt ?? 0;
				}
				// Never strip a process out from under a live or queued entry: hydrate() restored the queue BEFORE this pass, so a restart mid-party with the cap set would otherwise evict the playing song.
				const protectedIds = new Set<string>(entries.map((e) => e.mediaId));
				const currentMediaId = playback ? entries.find((e) => e.id === playback.currentEntryId)?.mediaId : undefined;
				if (currentMediaId) protectedIds.add(currentMediaId);
				const doomed = planEviction(candidates, cap, protectedIds);
				let freed = 0;
				for (const id of doomed) {
					const live = mediaById.get(id);
					if (!live) continue;
					freed += evictDerived(live).bytes;
					live.instrumentalRef = undefined;
					live.vocalsRef = undefined;
					// The mix IS those two stems in one file — evicting them evicts it.
					live.guideMixRef = undefined;
					live.lyricsRef = undefined;
					live.lyricsCandidates = [];
					live.stemStatus = 'none';
					mediaRepo.upsert(live);
					// upsert fires sidecarFromMedia, whose `?? prev` would RESTORE the refs just cleared — see clearArtifacts.
					await clearArtifacts(id);
				}
				if (doomed.length > 0) {
					console.log(
						`[core] retention: evicted derived artifacts for ${doomed.length} songs, freed ${(freed / 1e6).toFixed(1)} MB (cap ${(cap / 1e9).toFixed(1)} GB)`
					);
				}
			}
		}
	];

	// Detached — boot must not wait on it. Per-pass isolation lives in runBootMaintenance.
	void runBootMaintenance(bootTasks, (msg) => console.warn(`[core] ${msg}`));

	// The sinks are read THROUGH app, so server.ts can replace the socket map at boot without rebuilding the hub. plays/workerHub/reaper are CIRCULAR with app, so they capture it by reference and are only placed into the literal below — hence `let`, not `const`.
	// eslint-disable-next-line prefer-const
	let app: EncoreApp;

	// TWICE, deliberately: the SIDECAR carries the lifetime total retention's LRU reads, the LOG one row per performance — the only source that can answer WHEN, since queue_entries is wiped every flush. The log write is synchronous; the sidecar stays fire-and-forget so file I/O never delays the song starting.
	const plays = new PlayTracker((mediaId, entryId) => {
		playLog.record(mediaId, entryId, app.now());
		void (async () => {
			try {
				const side = await readSidecar(mediaId);
				if (!side) return; // not in the library (a plain search result) — nothing to record against
				side.library = { ...side.library, ...bumpPlay(side.library, app.now()) };
				await writeSidecar(side);
			} catch {
				/* a lost play count is not worth a failed playback */
			}
		})();
	});

	/* ONE probe for the whole app, so a stem silent enough to refuse at publish time is silent enough to refuse a guide link. */
	const loudness = ffmpegLoudnessProbe();

	const workerHub = new WorkerHub({
		jobs,
		attempts,
		registry: workers,
		mediaById,
		// Three-way on purpose: unmeasurable is NOT silence, so only a POSITIVE reading refuses a completion — no ffmpeg on the host must not become a self-inflicted outage.
		verifyInstrumental: async (ref) => {
			const abs = safeMediaPath(ref);
			if (!abs || !existsSync(abs)) return 'unknown'; // nothing to measure; the publish path judges the ref
			const reading = await loudness(abs);
			if (!reading) return 'unknown'; // no ffmpeg, a timeout, or an unreadable file
			return isDigitalSilence(reading) ? 'silent' : 'audible';
		},
		toWorker: (workerId, cmd) => app.toWorker(workerId, cmd),
		// No guide mix means the on-disk one was built from stems this frame replaced. A stale mix is structurally indistinguishable from a current one, so the next boot's backfill would adopt it.
		discardGuideMix: (mediaId) => {
			const abs = safeMediaPath(guideMixKey(mediaId));
			if (!abs) return;
			try {
				rmSync(abs, { force: true });
			} catch {
				/* best effort — a file we cannot remove is re-probed by the next backfill */
			}
		},
		broadcast: (e) => app.publish(e),
		// Remote workers pull source and push stems via this store config.
		mediaStore: mediaStoreConfig,
		// EFFECTIVE (global+room), so the room's downward-only quality ceiling actually reaches dispatch.
		getSettings: () => app.settings.getEffective(app.activeRoomId),
		// Persist the ready flip, or the next boot re-processes a song already on disk.
		persistMedia: (mediaId) => {
			const m = mediaById.get(mediaId);
			if (m) mediaRepo.upsert(m);
		},
		// queue:sync FIRST, so clients get the new ready status BEFORE reconcile — otherwise the TV's cached media stays 'queued' until a later sync.
		onMediaReady: () => {
			app.publish(
				syncEvent(state, {
					mediaById,
					listSingers: () => app.singers.listPublic(app.activeRoomId),
					listOnline: () => app.presence.online(),
					getSettings: () => app.settings.getEffective(app.activeRoomId)
				})
			);
			// Not optional garnish: reconcileOnReady picks what plays next, so without them it uses fair rotation while clients see the ordering the room actually chose.
			reconcileOnReady({
				state,
				publish: (e) => app.publish(e),
				mediaById,
				listSingers: () => app.singers.listPublic(app.activeRoomId),
				getSettings: () => app.settings.getEffective(app.activeRoomId),
				onNowPlaying: (e) => app.plays.onNowPlaying(e),
				onSang: (singerId) => app.singers.markSang(singerId, app.now())
			});
		},
		now: () => app.now()
	});

	// A lease expiry may have changed capacity, so redispatch.
	const reaper = new JobReaper(jobs, {
		onReaped: () => workerHub.dispatch(),
		// EVERY tick, not only when sweep() reaps something: dispatch() is event-driven, so on an EMPTY fleet nothing else ever calls it and a job with no capable worker parks queued forever.
		onTick: () => workerHub.dispatch(),
		// A reaper-killed process reaches terminal `failed` without the worker reporting it, so it never hits worker-hub's onFailed. The SAME shared epilogue must run here, or the phone stays pinned on the processing percentage forever.
		onFailed: (job) => reportTerminalFailure(job, 'reaper', { broadcast: (e) => app.publish(e), mediaById })
	});

	app = {
		db,
		state,
		singers,
		rooms,
		activeRoomId,
		presence: new PresenceTracker(),
		plays,
		jobs,
		attempts,
		playLog,
		settings,
		reaper,
		workers,
		workerHub,
		mediaById,
		media: mediaRepo,
		localLibrary: new LocalLibrary(),
		youtube: new YouTubeResolver(ytDlpSearch),
		spotify: new SpotifyResolver((q, n) => spotifySearch(q, n)),
		popularity: createPopularityTracker(),
		mediaStore,
		mediaStoreConfig,
		// No-op sinks until server.ts wires Bun.serve; routes and state still work without them.
		publish: () => {},
		toWorker: () => {},
		now: () => Date.now()
	};

	// A restart drops every worker WS session, so an assigned/running row is orphaned. One-shot, before server.ts starts the reaper tick loop.
	app.reaper.recoverOnBoot();

	g[APP_KEY] = app;
	return g[APP_KEY]!;
}

/** server.ts calls this at boot to route broadcasts through Bun.serve's native pub/sub. */
export function setPublish(fn: (e: ServerEvent) => void): void {
	getApp().publish = fn;
}

/** The genuinely per-socket inputs to a HubDeps bag. Everything else is read off `app` by {@link buildHubDeps}. */
export interface HubDepsPerFrame {
	/** Broadcast to the whole room (Bun pub/sub); the one sink hoisted at boot in server.ts. */
	broadcast: Publish;
	actorSingerId: string | undefined;
	listOnline: () => string[];
	/** Singer ids in the room but unreachable (locked phone, pocket). */
	listAway: () => string[];
	/** Idempotency ledger, RECORD-ON-CHECK — true if already applied, else records it. */
	seenOp: (clientOpId: string) => boolean;
	/** NON-RECORDING peek at the same ledger (validation-failure re-ack path). */
	hasOp: (clientOpId: string) => boolean;
}

/**
 * The single place the hub's optional hooks are wired to live services — a new hook goes HERE, not at
 * every composition site. The hubdeps-composition-parity guard asserts this literal fills every optional
 * HubDeps key, so a dropped hook still reds.
 */
export function buildHubDeps(app: EncoreApp, perFrame: HubDepsPerFrame): HubDeps {
	return {
		state: app.state,
		publish: perFrame.broadcast,
		mediaById: app.mediaById,
		listSingers: () => app.singers.listPublic(app.activeRoomId),
		listOnline: perFrame.listOnline,
		listAway: perFrame.listAway,
		getSettings: () => app.settings.getEffective(app.activeRoomId),
		onNowPlaying: (e) => app.plays.onNowPlaying(e),
		onSang: (singerId) => app.singers.markSang(singerId, app.now()),
		recordAdd: (mediaId) => app.popularity.recordAdd(mediaId, app.now()),
		// Stops the process, settles the media back to un-processed, tells the room. No-ops when a shared process is still needed by another entry.
		onEntryRemoved: (mediaId: string, remainingEntries: QueueEntry[]) =>
			cancelJobsForMedia(mediaId, {
				jobs: app.jobs,
				toWorker: app.toWorker,
				remainingEntries,
				now: app.now,
				mediaById: app.mediaById,
				broadcast: perFrame.broadcast
			}),
		// The add-side mirror: a process filed at NO_QUEUE_PRIORITY is pulled to the turn's rotation position and dispatch kicked. No-ops with no process in flight.
		onEntryAdded: (mediaId: string, entries: QueueEntry[]) =>
			reprioritizeProcessForMedia(mediaId, {
				jobs: app.jobs,
				entries,
				now: app.now,
				dispatch: () => app.workerHub.dispatch()
			}),
		actorSingerId: perFrame.actorSingerId,
		seenOp: perFrame.seenOp,
		hasOp: perFrame.hasOp
	};
}
