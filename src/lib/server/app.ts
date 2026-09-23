// Shared runtime singleton — the seam between SvelteKit routes and the WS hub; both run in ONE Bun process, so this module-level instance is deliberately the single source of truth (routes mutate state, call app.publish(); server.ts injects the real Bun.serve publish at boot). See docs/SERVER.md#authority-and-the-hub.

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
	clearArtifacts
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
	/** Room lifecycle: create a party (mint id + join code) and look one up by code. */
	rooms: RoomRepository;
	/** Room a bare `/join` lands in when no code is given, and the room whose code the TV QR advertises; an explicit code resolves via {@link rooms} instead. */
	activeRoomId: string;
	/** Who holds a live socket right now. Populated by server.ts's WS open/close. */
	presence: PresenceTracker;
	/** Records a play when the current entry changes (retention's LRU recency signal) — wire `app.plays.onNowPlaying` at every HubDeps.onNowPlaying call site. */
	plays: PlayTracker;
	jobs: JobRepository;
	/** Per-attempt processing history — durations, models, failures. The dashboards read this. */
	attempts: AttemptLedger;
	/** One row per performance — the time axis the sidecar's play COUNTER cannot provide. */
	playLog: PlayLog;
	/** Room-level separator settings: the engine/model a process uses + the upgrade policy. */
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
	/** Send a WorkerCommand to ONE worker session; replaced by server.ts with the real socket map. */
	toWorker: (workerId: string, cmd: WorkerCommand) => void;
	now: () => number;
}

/** Build the MediaStore (+ its wire config) from env; object-store is lazy — the S3 client is only constructed when MEDIA_STORE=object resolves to a usable bucket, otherwise the local default. */
function buildMediaStore(): { store: MediaStore; config: MediaStoreConfig } {
	const config = resolveMediaStoreConfig(process.env);
	if (config.kind === 'object') {
		return { store: new ObjectMediaStore(bunS3Client(config), config), config };
	}
	return { store: new LocalMediaStore(), config };
}

// CRITICAL: SvelteKit's prod bundle is a SEPARATE module graph from server.ts's, so a module-level `let _app` would give each its own instance (split-brain state, separate :memory: DBs in dev) — globalThis guarantees ONE shared instance across both.
const APP_KEY = Symbol.for('encore.app');
type GlobalWithApp = typeof globalThis & { [APP_KEY]?: EncoreApp };

/** Build (once) the shared app. Idempotent — repeated calls return the same instance. */
export function getApp(): EncoreApp {
	const g = globalThis as GlobalWithApp;
	if (g[APP_KEY]) return g[APP_KEY];

	// File-backed SQLite by default — singers/queue/playback survive restarts (forgetting everyone on restart is a bug, not a feature). DATA_DIR overrides the location; ENCORE_EPHEMERAL=1 forces a throwaway :memory: DB.
	const dbPath = process.env.ENCORE_EPHEMERAL === '1' ? ':memory:' : defaultDbPath();
	const { db } = openDb(dbPath);
	runMigrations(db);

	// Bring the media volume onto the storage classes before anything reads the catalog (idempotent, so it stays wired permanently). WRAPPED: storage housekeeping must NEVER stop the server from booting — a box that won't start because it couldn't tidy a directory is worse than a volume left on the old layout.
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

	// Settings BEFORE authoritative state: state's ordering (which algorithm decides who sings next) reads settings live via a getter, since the room can change algorithm mid-party.
	const settings = new SettingsRepository(db);
	const singers = new SingerRepository(db);
	const rooms = new RoomRepository(db);
	// Mint the party's identity on first boot, reused on every boot after — gives the QR a code and the join path a room for a bare `/join`.
	const activeRoomId = rooms.ensureActive(Date.now()).id;
	const state = new AuthoritativeState(sqlitePersistence(db, activeRoomId), 250, () =>
		orderingOf({
			getSettings: () => settings.getEffective(activeRoomId),
			listSingers: () => singers.listPublic(activeRoomId)
		})
	);
	const { entries, playback } = hydrate(db, activeRoomId);
	state.hydrate(entries, playback);

	// The attempt ledger is jobs' historical half: `jobs` holds one live row per (mediaId, jobType), overwritten in place, so every past duration/attempt would otherwise be lost.
	const attempts = new AttemptLedger(db);
	const playLog = new PlayLog(db);
	const jobs = new JobRepository(db, attempts);
	// Seed this room's pacing from env on first boot ONLY — writing it every boot would stomp whatever the room later chose on the phone. INTERSTITIAL_MS is a deprecated alias kept for upgrade parity; =0 still means "off".
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

	// Hydrate the runtime catalog from the durable store BEFORE anything reads it — otherwise a restart forgets every song title and re-processes songs whose stems are already on disk. The DB indexes the sidecars (every persist refreshes meta/<id>.json; a sidecar missing from the index is restored below), so losing the SQLite file costs a rebuild, not the library. The persist callback only ever runs after an await, so `mediaRepo` is fully initialised by the time it reads it.
	const mediaRepo = new MediaRepository(db, (m) => {
		void (async () => {
			try {
				const prev = await readSidecar(m.id);
				const next = sidecarFromMedia(m, Date.now(), prev);
				await writeSidecar(next);
				// Mirror canonical metadata into the index for browse grouping; browseArtist returns null on a low-confidence parse so an uncertain guess never becomes a wrong library heading.
				mediaRepo.setCanonical(m.id, {
					artist: browseArtist(next),
					title: lookupTitle(next),
					album: next.canonical.album,
					year: next.canonical.year
				});
				if (next.library.tags.length) mediaRepo.setTags(m.id, 'tag', next.library.tags);
			} catch {
				/* the sidecar is the durable record, not the live one — never fail a flip over it */
			}
		})();
	});
	hydrateMediaCatalog(mediaRepo.all(), mediaById);

	// Re-derive any readiness gate the durable row claims is in flight while nothing alive can finish it. SYNCHRONOUS, here, and BEFORE the party is serveable — a stranded song must never be observable as stranded, and deferring it would hand the first /api/library load the exact row this repairs. Idempotent; WRAPPED for the same boot-resilience reason as the storage migration above.
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

	// Detached boot-time library maintenance: independent passes that restore/repair the library after boot. Each pass is ISOLATED — one throwing must not skip the rest, and its failure must be named, not folded into one catch that can't say which pass died. Runs off the main thread; hydrateMediaCatalog already made the party serveable synchronously above.
	const bootTasks: BootTask[] = [
		{
			name: 'sidecar restore + backfill',
			run: async () => {
				// Restore anything the sidecars know that the index doesn't, then re-describe what the index already knows — together making the media volume portable: drop it on a new box, or delete the SQLite file, and the library comes back.
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
				// Mirror canonical artist/album/year from every sidecar into the browse index. Its own pass because backfilling a sidecar doesn't go through upsert, so without it browse would only see songs touched since the process started.
				let indexed = 0;
				for (const sc of await readAllSidecars()) {
					mediaRepo.setCanonical(sc.id, {
						artist: browseArtist(sc),
						title: lookupTitle(sc),
						album: sc.canonical.album,
						year: sc.canonical.year
					});
					// Also patch the RUNTIME map, not just the index — hydrateMediaCatalog ran synchronously at boot while this pass is async, so DB-only mirroring left in-memory Media without canonicals for the process's life. Patch only these fields: a wholesale replace would undo a live entry that flipped to processing since hydrate.
					const live = mediaById.get(sc.id);
					if (live) {
						const artist = browseArtist(sc);
						const title = lookupTitle(sc);
						if (artist) live.artistCanonical = artist;
						if (title) live.titleCanonical = title;
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
				// Links the vocals stem for songs processed while the core was dropping that artifact. Pure filesystem work (nothing to queue, nothing competing with a live process). A silent stem is counted but deliberately not linked — see media/loudness.ts.
				const res = await backfillVocalsRefs(mediaById.values(), {
					resolve: (ref) => safeMediaPath(ref),
					exists: (abs) => existsSync(abs),
					measure: async (abs) => {
						const reading = await loudness(abs);
						if (!reading) return 'unknown'; // no ffmpeg — cannot judge, do not pretend to
						return isDigitalSilence(reading) ? 'silent' : 'audible';
					},
					link: (id, ref) => {
						// Runtime map AND the durable index: in-memory Media is what the player/phone read; upsert is what survives the next restart (and records it in meta/).
						const live = mediaById.get(id);
						if (!live) return;
						live.vocalsRef = ref;
						mediaRepo.upsert(live);
					}
				});
				if (res.linked > 0) console.log(`[core] guiding track: linked the vocals stem for ${res.linked} song(s)`);
				if (res.unmeasured > 0) {
					// Named separately from `linked`: trusted, not verified. Two causes an operator needs distinguished: no ffmpeg on PATH, or a stripped ffmpeg build that can't demux this format.
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
				// Songs processed before the align pipeline existed have no align job and no way to get one. Enqueued at the LOWEST priority so a singer's live process always jumps the whole backfill queue; dedup on (mediaId, jobType) makes a restart idempotent.
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
				// Recompress legacy stems in place. Pre-audio-policy WAV stems run ~8x larger than a process produces today; the bytes are already here, so this needs no download and no Demucs run. Eviction would be the wrong tool — it would drop those songs until re-processed.
				const targets = planRecompress(mediaRepo.all());
				if (targets.length === 0) return;
				const rc = await recompressLegacyStems(targets, ffmpegTranscoder());
				// Always report: a pass that converted NOTHING and failed everything must not look identical to a pass that had nothing to do.
				console.log(
					`[core] recompress: ${rc.converted}/${targets.length} legacy stems converted, ` +
						`${(rc.bytesBefore / 1e6).toFixed(1)} MB → ${(rc.bytesAfter / 1e6).toFixed(1)} MB ` +
						`(reclaimed ${((rc.bytesBefore - rc.bytesAfter) / 1e6).toFixed(1)} MB)` +
						(rc.skipped ? `, ${rc.skipped} skipped` : '') +
						(rc.failed ? `, ${rc.failed} FAILED — ${transcodeDiagnostics.lastError || 'ffmpeg unavailable'}` : '')
				);
				// Point each media at its new artifact. Goes through upsert, so the sidecar follows.
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
				// Evict derived artifacts if over the soft cap. `audio/` and `meta/` are never candidates.
				const cap = retentionCapBytes();
				if (cap === null) return;
				const ready = mediaRepo.listReady();
				const candidates = ready.map((m) => ({ mediaId: m.id, derivedBytes: derivedBytesOf(m), lastUsedAt: 0 }));
				// recency comes from the sidecar: lastPlayedAt (wired via plays.ts), else addedAt for never-played
				for (const c of candidates) {
					const side = await readSidecar(c.mediaId);
					c.lastUsedAt = side?.library.lastPlayedAt ?? side?.library.addedAt ?? 0;
				}
				// Never strip a process out from under a live or queued entry: hydrate() above restored the queue/playback BEFORE this pass, so a restart mid-party with the cap set could otherwise evict the playing/queued song. Protect every queued id plus the current one.
				const protectedIds = new Set<string>(entries.map((e) => e.mediaId));
				const currentMediaId = playback ? entries.find((e) => e.id === playback.currentEntryId)?.mediaId : undefined;
				if (currentMediaId) protectedIds.add(currentMediaId);
				const doomed = planEviction(candidates, cap, protectedIds);
				let freed = 0;
				for (const id of doomed) {
					const live = mediaById.get(id);
					if (!live) continue;
					freed += evictDerived(live).bytes;
					// back to un-processed: rotation stops treating it as playable, a re-request re-processes it
					live.instrumentalRef = undefined;
					live.vocalsRef = undefined;
					// The mix IS those two stems in one file — evicting them evicts it.
					live.guideMixRef = undefined;
					live.lyricsRef = undefined;
					live.lyricsCandidates = [];
					live.stemStatus = 'none';
					mediaRepo.upsert(live);
					// upsert fires sidecarFromMedia, whose `?? prev` would RESTORE the refs just cleared; null them directly on the authoritative record so the eviction sticks.
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

	// Detached — boot must not wait on it. Per-pass isolation lives in runBootMaintenance: one pass's failure is named and doesn't skip the rest.
	void runBootMaintenance(bootTasks, (msg) => console.warn(`[core] ${msg}`));

	// app's sinks (toWorker/broadcast) are read THROUGH app so server.ts can replace the socket map at boot without rebuilding the hub. plays/workerHub/reaper are circular with app — each closes over it — so they're built as locals capturing `app` by reference (the closures run long after construction) and only placed into the literal below; `app` is never observed null-typed. Hence `let`, not `const`.
	// eslint-disable-next-line prefer-const
	let app: EncoreApp;

	// A play is recorded TWICE: the SIDECAR carries the lifetime total retention's LRU reads (one small JSON write); the LOG carries one row per performance — the only source that can answer WHEN, since queue_entries is wiped on every flush/boot. The log write is synchronous; the sidecar stays fire-and-forget so file I/O never delays the song starting.
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

	/* ONE loudness probe for the whole app: the live publish gate and the boot backfill measure the same way, so a stem silent enough to refuse at publish time is silent enough to refuse a guide link. */
	const loudness = ffmpegLoudnessProbe();

	const workerHub = new WorkerHub({
		jobs,
		attempts,
		registry: workers,
		mediaById,
		// Defence in depth on the live publish, using the SAME measurement the boot backfill uses — the worker's own completion report was previously trusted uncritically, so a silent instrumental could become READY and the singer found out by singing it. Three-way on purpose: unmeasurable is NOT silence, so only a POSITIVE reading refuses a completion (no ffmpeg must not become a self-inflicted outage).
		verifyInstrumental: async (ref) => {
			const abs = safeMediaPath(ref);
			if (!abs || !existsSync(abs)) return 'unknown'; // nothing to measure; the publish path judges the ref
			const reading = await loudness(abs);
			if (!reading) return 'unknown'; // no ffmpeg, a timeout, or an unreadable file
			return isDigitalSilence(reading) ? 'silent' : 'audible';
		},
		toWorker: (workerId, cmd) => app.toWorker(workerId, cmd),
		// A completion with no guide mix means the on-disk mix was built from stems this frame just replaced (a stems-upgrade re-separates in place). Delete it — a stale mix is structurally indistinguishable from a current one, so the next boot's backfill would adopt it and the room would play stale stems while instrumentalRef/separator both advertise the better ones.
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
		// remote workers pull source / push stems via this store config (local volume or S3/MinIO)
		mediaStore: mediaStoreConfig,
		// A stems/upgrade job carries the room's chosen engine+model, read live at assign time. EFFECTIVE (global+room) so the room's downward-only quality ceiling actually reaches dispatch.
		getSettings: () => app.settings.getEffective(app.activeRoomId),
		// A processed song is durable — persist the ready flip so the next boot lists it in the karaoke library instead of re-processing it.
		persistMedia: (mediaId) => {
			const m = mediaById.get(mediaId);
			if (m) mediaRepo.upsert(m);
		},
		// When a processed song flips ready, reconcile playback (start if idle) — the held entry slots back at its fair position. Broadcast queue:sync FIRST so clients get the new sourceRef/ready status before reconcile, or the TV's cached media stays 'queued' until a later sync.
		onMediaReady: () => {
			app.publish(
				syncEvent(state, {
					mediaById,
					listSingers: () => app.singers.listPublic(app.activeRoomId),
					listOnline: () => app.presence.online(),
					getSettings: () => app.settings.getEffective(app.activeRoomId)
				})
			);
			// listSingers + getSettings are not optional garnish: reconcileOnReady picks what plays next, so without them it would use fair rotation while clients see a queue the room actually chose.
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

	// When the reaper requeues/fails a job (lease expiry), capacity may have changed → redispatch.
	const reaper = new JobReaper(jobs, {
		onReaped: () => workerHub.dispatch(),
		// EVERY tick, not only when sweep() reaps something: dispatch() is event-driven, so on an EMPTY fleet nothing else ever calls it — sweep() finds nothing, onReaped never fires, and a job with no capable worker parks queued forever. onTick is what ends that hang.
		onTick: () => workerHub.dispatch(),
		// A reaper-killed process (worker died, attempts exhausted) reaches terminal `failed` without the worker reporting it, so it never hits worker-hub's onFailed. Call the SAME shared epilogue here — settle the gate, tell the room, log one uniform line, reclaim scratch — with `cause: 'reaper'` so the operator can grep this path apart; otherwise the phone stays pinned on the processing percentage forever.
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
		// no-op sinks until server.ts wires Bun.serve; routes/state still work without them
		publish: () => {},
		toWorker: () => {},
		now: () => Date.now()
	};

	// Boot recovery (§3): a restart drops every worker WS session, so any job still marked assigned/running is orphaned — reset to queued for redispatch. One-shot, before server.ts starts the reaper tick loop; no-op on a fresh/in-memory DB.
	app.reaper.recoverOnBoot();

	g[APP_KEY] = app;
	return g[APP_KEY]!;
}

/** server.ts calls this at boot to route broadcasts through Bun.serve's native pub/sub. */
export function setPublish(fn: (e: ServerEvent) => void): void {
	getApp().publish = fn;
}

/** The genuinely per-socket / per-frame inputs to a HubDeps bag — everything NOT derivable from the shared app (broadcast sink, actor singer, membership snapshot, idempotency ledger). Everything else is read off `app` by {@link buildHubDeps}. */
export interface HubDepsPerFrame {
	/** Broadcast to the whole room (Bun pub/sub); the one sink hoisted at boot in server.ts. */
	broadcast: Publish;
	/** The singer this socket authenticated as, or undefined for a socket that never joined. */
	actorSingerId: string | undefined;
	/** Singer ids holding a live socket right now. */
	listOnline: () => string[];
	/** Singer ids in the room but unreachable (locked phone, pocket). */
	listAway: () => string[];
	/** Idempotency ledger, RECORD-ON-CHECK — true if already applied, else records it. */
	seenOp: (clientOpId: string) => boolean;
	/** NON-RECORDING peek at the same ledger (validation-failure re-ack path). */
	hasOp: (clientOpId: string) => boolean;
}

/**
 * Assemble a complete {@link HubDeps} for one WS frame: the single place the hub's optional hooks
 * (listSingers, getSettings, onNowPlaying, onSang, recordAdd, onEntryRemoved, onEntryAdded) are wired
 * to live services — a new hook goes here, not at every composition site. Per-call inputs come from
 * {@link HubDepsPerFrame}. The hubdeps-composition-parity guard asserts this literal fills every
 * optional HubDeps key, so a dropped hook still reds.
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
		// An explicit remove of a processing song stops the process (subprocess kill + slot release + dedup-slot free), settles the media back to un-processed, and tells the room. No-ops when a shared process is still needed by another entry.
		onEntryRemoved: (mediaId: string, remainingEntries: QueueEntry[]) =>
			cancelJobsForMedia(mediaId, {
				jobs: app.jobs,
				toWorker: app.toWorker,
				remainingEntries,
				now: app.now,
				mediaById: app.mediaById,
				broadcast: perFrame.broadcast
			}),
		// The add-side mirror: a process filed at NO_QUEUE_PRIORITY (process POST beat the queue add over a reconnecting socket) is pulled to the turn's rotation position and dispatch kicked. No-ops with no process in flight (starvation half).
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
