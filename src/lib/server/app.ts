// Shared runtime singleton — the seam between SvelteKit `+server.ts` API routes and the
// Bun.serve WS hub. In production both run in ONE Bun process (ARCHITECTURE §2), so a
// module-level singleton is the correct, simplest wiring: routes mutate authoritative state
// and call app.publish(); server.ts injects the real Bun.serve publish at boot.

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
	/**
	 * The id of the party a join lands in when no room code is given — the single room an earlier change mints.
	 * The join path resolves an explicit code against {@link rooms}; this is the fallback identity
	 * for a bare `/join`, and the room whose code the TV QR advertises.
	 */
	activeRoomId: string;
	/** Who holds a live socket right now. Populated by server.ts's WS open/close. */
	presence: PresenceTracker;
	/**
	 * Records a play when the current entry changes — the recency signal retention's LRU eviction
	 * needs. Pass `app.plays.onNowPlaying` as HubDeps.onNowPlaying wherever deps are built.
	 */
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
	mediaStore: MediaStore; // local volume (default) or object-store (S3/MinIO) — ARCHITECTURE §2
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
	runMigrations(db);

	// Bring the media volume onto the storage classes BEFORE anything reads the catalog.
	// Idempotent — a no-op on a fresh or already-migrated volume — so it stays wired in permanently.
	// The raw original is PROMOTED out of the old scratch dir rather than deleted with it; DB refs are
	// rewritten in the same pass so instrumentalRef/lyricsRef keep pointing at real files.
	//
	// WRAPPED, and deliberately so: storage housekeeping must NEVER stop the party server from
	// booting. The first real run of this crashed startup on an EACCES, because the old scratch dir
	// was owned by the worker container's uid. A karaoke box that will not start because it could not
	// tidy a directory is a far worse failure than a volume that stays on the old layout.
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

	// Settings BEFORE the authoritative state, because the state's ordering (which algorithm decides
	// who sings next) is read out of them. A getter, not a value: the room can change the algorithm
	// mid-party and the sing history moves every time a song starts.
	const settings = new SettingsRepository(db);
	const singers = new SingerRepository(db);
	const rooms = new RoomRepository(db);
	// Mint the party's identity on first boot (reuse it on every boot after). Until an earlier change nothing wrote
	// the rooms table, so a fresh box had a real singers/queue/playback state but no room to name it;
	// this gives the QR a code to advertise and the join path a room to land an unqualified join in.
	const activeRoomId = rooms.ensureActive(Date.now()).id;
	const state = new AuthoritativeState(sqlitePersistence(db, activeRoomId), 250, () =>
		orderingOf({
			getSettings: () => settings.getEffective(activeRoomId),
			listSingers: () => singers.listPublic(activeRoomId)
		})
	);
	const { entries, playback } = hydrate(db, activeRoomId);
	state.hydrate(entries, playback);

	// The attempt ledger is the historical half of the job system: `jobs` holds one live row per
	// (mediaId, jobType) and is overwritten in place, so every duration and every past attempt would
	// otherwise be lost the moment it changed. Constructed here and handed to the repository, which
	// records each lifecycle transition against it.
	const attempts = new AttemptLedger(db);
	const playLog = new PlayLog(db);
	const jobs = new JobRepository(db, attempts);
	// Seed this room's pacing from the environment on first boot only. Without this, adding the room
	// scope would silently reset an install that had configured the env var, and writing it every boot
	// would instead stomp whatever someone chose on the phone.
	//
	// INTERSTITIAL_MS is still honoured as a deprecated alias so a deployed box does not change behavior
	// on upgrade, and =0 still means "off" — it now seeds the toggle rather than a sentinel duration.
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

	// Hydrate the runtime catalog from the durable store BEFORE anything reads it. Without this
	// a restart forgot every song title (a hydrated queue entry rendered as a raw id) and re-processed
	// songs whose stems were already sitting on disk.
	// The DB is an INDEX over the sidecars, so every persist refreshes meta/<id>.json, and a
	// sidecar present on disk but missing from the index is restored below. Together those give the
	// volume the property that matters: it describes itself, so losing the SQLite file costs an
	// index rebuild rather than every title and artifact link.
	// The persist callback closes over mediaRepo and only ever runs after an await, so the const
	// binding is fully initialised by the time the callback reads it.
	const mediaRepo = new MediaRepository(db, (m) => {
		void (async () => {
			try {
				const prev = await readSidecar(m.id);
				const next = sidecarFromMedia(m, Date.now(), prev);
				await writeSidecar(next);
				// Mirror the sidecar's canonical metadata into the INDEX so browse can group by
				// it. `browseArtist` returns null for a low-confidence parse, so an uncertain guess is
				// stored as NULL rather than becoming a library heading that is simply wrong.
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

	// Re-derive any readiness gate the durable row claims is in flight while the job ledger says nothing
	// alive can ever finish it (XR-JOB-04). SYNCHRONOUS and here, immediately after the hydrate that
	// reads the stale value and BEFORE the party is serveable — unlike the detached passes below this
	// does no directory scan and no network call (a handful of indexed lookups over only the rows that
	// claim to be processing), and its whole purpose is that a stranded song must not be observable as
	// stranded. Deferring it would hand the first phone to load /api/library the exact row the pass
	// exists to repair.
	//
	// Idempotent, so it stays wired permanently rather than being a one-shot script: a settled gate is
	// no longer in flight, so the next boot matches nothing and writes nothing.
	//
	// WRAPPED for the same reason migrateStorageLayout is: library housekeeping must never stop a party
	// server from booting. A repair that could not run leaves the songs it would have recovered exactly
	// as they already were — bad, but strictly better than a box that will not start.
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

	// Restore anything the sidecars know about that the index does not. This is what makes the media
	// volume portable: drop it on a new box (or delete the SQLite file) and the library comes back.
	// Async and non-blocking — boot must not wait on a directory scan, and a party server that will
	// not start because a rescan is slow is the worse failure.
	// ── boot library maintenance ─────────────────────────────────────────────────────────────
	// A detached chain of independent passes that restore/repair the library after boot. Each is
	// ISOLATED: a pass that throws (a hand-edited sidecar, a genuine bug) or is otherwise faulted must
	// NOT skip the passes after it, and its failure must be VISIBLE and NAMED — not folded into one
	// terminal catch that could not say which of six passes died. Runs off the main thread so boot never
	// waits on a directory scan; a party server that will not start because a rescan is slow is the worse
	// failure. hydrateMediaCatalog above already populated the runtime map synchronously, so the party is
	// already serveable before any of this runs.
	//
	// The table shape is deliberate: each pass already had a name, an optional env gate, a body, and a
	// report, applied by hand per site. The codebase discovered the "always report an outcome, even a
	// zero one" principle locally more than once (recompress; the unmeasured/linked split); the table is
	// where per-pass isolation is applied ONCE for all of them.
	const bootTasks: BootTask[] = [
		{
			name: 'sidecar restore + backfill',
			run: async () => {
				// Restore anything the sidecars know about that the index does not, then describe every song
				// the index already knows. Together these make the media volume portable: drop it on a new box
				// (or delete the SQLite file) and the library comes back.
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
				// Mirror canonical artist/album/year from every sidecar into the browse index.
				// Needed as its own pass because backfilling a sidecar does not go through upsert, so without
				// it browse would only see songs touched since the process started.
				let indexed = 0;
				for (const sc of await readAllSidecars()) {
					mediaRepo.setCanonical(sc.id, {
						artist: browseArtist(sc),
						title: lookupTitle(sc),
						album: sc.canonical.album,
						year: sc.canonical.year
					});
					//...and into the RUNTIME map, not just the index. hydrateMediaCatalog above ran
					// synchronously at boot while this pass is async, so mirroring only to the DB left every
					// in-memory Media without its canonicals for the whole process lifetime — invisible to
					// browse (which queries the index) but not to anything reading mediaById. It surfaced as an
					// align job dispatched with `artist` but no `track`. Patch only these fields: a live entry
					// may have flipped to processing since hydrate, and a wholesale replace would undo that.
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
				// Link the vocals stem for songs processed while the core was dropping that artifact. Pure
				// filesystem work — no job, no worker, no cpu — so unlike the lyrics backfill there is nothing
				// to queue and nothing for a singer's live process to compete with. A silent stem is counted and
				// deliberately NOT linked: see media/loudness.ts.
				const res = await backfillVocalsRefs(mediaById.values(), {
					resolve: (ref) => safeMediaPath(ref),
					exists: (abs) => existsSync(abs),
					measure: async (abs) => {
						const reading = await loudness(abs);
						if (!reading) return 'unknown'; // no ffmpeg — cannot judge, do not pretend to
						return isDigitalSilence(reading) ? 'silent' : 'audible';
					},
					link: (id, ref) => {
						// Runtime map AND the durable index: the in-memory Media is what the player and the
						// phone read, while the upsert is what makes it survive the next restart (and, via
						// the repository's sidecar sink, what records it in meta/).
						const live = mediaById.get(id);
						if (!live) return;
						live.vocalsRef = ref;
						mediaRepo.upsert(live);
					}
				});
				if (res.linked > 0) console.log(`[core] guiding track: linked the vocals stem for ${res.linked} song(s)`);
				if (res.unmeasured > 0) {
					// Named separately from `linked` on purpose: these were trusted, not verified. Reporting
					// them as linked would tell the operator the stems were checked when no check ran.
					// Two causes, and the operator needs both: no ffmpeg on PATH at all, or an ffmpeg that
					// cannot DEMUX this format — a stripped build (the one Playwright ships, for instance)
					// runs fine and still refuses an m4a with "Invalid data found".
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
				// Songs processed before the align pipeline existed have no align job and no way to get one, so
				// the library's existing catalog would never gain lyrics. Enqueued at the LOWEST priority so a
				// singer's live process always jumps the whole backfill queue, and dedup on (mediaId, jobType)
				// makes a restart idempotent.
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
				// Recompress legacy stems in place. Songs processed before the audio policy carry WAV stems ~8x
				// larger than a process produces today; the bytes are already here, so this needs no download and
				// no Demucs run, and the song never leaves the library. Eviction would have been the wrong
				// tool: it would drop those songs until re-processed.
				const targets = planRecompress(mediaRepo.all());
				if (targets.length === 0) return;
				const rc = await recompressLegacyStems(targets, ffmpegTranscoder());
				// Always report: a pass that converted NOTHING and failed everything must not look
				// identical to a pass that had nothing to do.
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
				// Never strip a process out from under a live or queued entry. hydrate() (above) restored the
				// queue and playback BEFORE this pass, so a restart mid-party with the cap set could otherwise
				// evict the playing/queued song. Protect every queued media id plus the currently-playing one.
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
					// upsert fires sidecarFromMedia, whose `?? prev` would RESTORE the refs just cleared;
					// null them directly on the authoritative record so the eviction sticks.
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

	// Detached: boot must not wait on it. Per-pass isolation lives in runBootMaintenance — one pass's
	// failure is named and does not skip the rest (issue an earlier change defect 1).
	void runBootMaintenance(bootTasks, (msg) => console.warn(`[core] ${msg}`));

	// The app object is built below; the hub's sinks (toWorker/broadcast) read THROUGH the app so
	// server.ts can replace the real socket map at boot without rebuilding the hub.
	//
	// plays/workerHub/reaper are genuinely circular: each closes over `app` (its now/publish/toWorker
	// and, for reaper, workerHub.dispatch), and `app` cannot exist until they do. Rather than fill the
	// three fields with `null as never` and patch them in after — which lied to EncoreApp's type for
	// the window in between — build them as locals that capture `app` by reference (the closures only
	// run long after construction, so the forward reference is safe), then place the real values in
	// the literal. `app` is therefore never observed as null-typed.
	//
	// `let` (not `const`) is required: the plays/workerHub/reaper closures below capture `app` by
	// reference, so it cannot be a `const` initialised from its own literal.
	// eslint-disable-next-line prefer-const
	let app: EncoreApp;

	// A play is recorded TWICE, deliberately, because the two answer different questions:
	//   - the SIDECAR carries the authoritative lifetime total and the recency retention's LRU reads.
	//     One small JSON write per song, no migration.
	//   - the LOG carries one row per performance, which is the only thing that can answer WHEN. A
	//     counter cannot produce a trend line, and queue_entries is wiped on every flush and on boot.
	// The log write is synchronous and tiny (one indexed insert); the sidecar write stays
	// fire-and-forget because it is file I/O and bookkeeping must never delay the song starting.
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

	/*
	 * ONE loudness probe for the whole app: the live publish gate below and the boot guiding-track
	 * backfill both measure the same way, because a stem that is silent enough to refuse at publish time
	 * is silent enough to refuse a guide link, and two thresholds would eventually disagree.
	 */
	const loudness = ffmpegLoudnessProbe();

	const workerHub = new WorkerHub({
		jobs,
		attempts,
		registry: workers,
		mediaById,
		/*
		 * Defence in depth on the live publish, using the SAME measurement the boot backfill uses.
		 *
		 * `media/loudness.ts` has been able to spot a digitally-silent stem since two songs in the live
		 * library turned out to be exactly that — both stems at the 16-bit floor, sitting in the Ready list
		 * and ready to play four minutes of nothing. But it was only ever invoked by the guiding-track
		 * backfill, so the path that PUBLISHES a fresh separation trusted whatever the worker reported: a
		 * silent instrumental became a READY song, and the singer found out by singing it.
		 *
		 * Three-way on purpose, and the third case is the safety property: unmeasurable is not silence. A
		 * box with no ffmpeg measures nothing, and refusing every process it ran would be a self-inflicted
		 * outage — so only a POSITIVE measurement of silence refuses the completion.
		 */
		verifyInstrumental: async (ref) => {
			const abs = safeMediaPath(ref);
			if (!abs || !existsSync(abs)) return 'unknown'; // nothing to measure; the publish path judges the ref
			const reading = await loudness(abs);
			if (!reading) return 'unknown'; // no ffmpeg, a timeout, or an unreadable file
			return isDigitalSilence(reading) ? 'silent' : 'audible';
		},
		toWorker: (workerId, cmd) => app.toWorker(workerId, cmd),
		// A completion frame with no guide mix means the mix on disk was built from stems this frame has
		// just replaced (a stems-upgrade re-separates and overwrites both stem files in place). Delete it:
		// a stale mix is structurally valid — four channels, right duration — so nothing downstream can
		// tell it apart from a current one, and the next boot's backfill would ADOPT it and re-record a ref
		// to the superseded separation. The room would then play the worse stems while `instrumentalRef`
		// and `Media.separator` both advertise the better ones, with no way to notice.
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
		// A stems/upgrade job carries the room's chosen engine+model, read live at assign time. EFFECTIVE
		// (global+room) so the room's downward-only quality ceiling actually reaches dispatch — the hub
		// folds resolveProcessSeparator over this before handing the pure dispatch layer its settings.
		getSettings: () => app.settings.getEffective(app.activeRoomId),
		// A processed song is durable — persist the ready flip (instrumental key + lyrics + pitch)
		// so the next boot lists it in the karaoke library instead of re-processing it.
		persistMedia: (mediaId) => {
			const m = mediaById.get(mediaId);
			if (m) mediaRepo.upsert(m);
		},
		// When a processed song flips to ready, reconcile playback (start if the room idled / preload) —
		// the held entry slots back at its fair position. Broadcast a fresh queue:sync FIRST
		// so every client updates its media catalog with the now-ready song's new sourceRef (the
		// instrumental key) + ready status — otherwise the TV's cached media stays 'queued' and sits
		// on the WAITING screen (the "big gap" between process-finish and playback) until a later sync.
		onMediaReady: () => {
			app.publish(
				syncEvent(state, {
					mediaById,
					listSingers: () => app.singers.listPublic(app.activeRoomId),
					listOnline: () => app.presence.online(),
					getSettings: () => app.settings.getEffective(app.activeRoomId)
				})
			);
			// listSingers + getSettings are not optional garnish here: reconcileOnReady picks what plays
			// next, so without them it would pick using fair rotation while every client is looking at a
			// queue ordered by whatever the room actually chose.
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
		// EVERY TICK, not only when sweep() found something to reap. The unservable-job TTL is evaluated
		// inside dispatch(), which is event-driven, so on an EMPTY fleet nothing ever calls it: sweep()
		// finds no actions, onReaped never fires, dispatch() is never called again, and a job whose
		// capability nothing advertises parks queued forever. That is precisely the hang the TTL exists to
		// end, reproduced in the quietest case.
		onTick: () => workerHub.dispatch(),
		// A reaper-killed process (worker box died, attempts exhausted) reaches terminal `failed` without
		// the worker reporting it, so it never hits #onFailed. The reaper has no catalog, so it hands
		// the job up and we do here EXACTLY what the reported (#onFailed) and unservable-TTL paths do —
		// otherwise a reaper-killed process is completely silent: the gate settles but the
		// room is told nothing, so every phone that watched it process stays pinned on "Making karaoke… N%"
		// with no Sing button, for the life of the page (displayReadiness lets the last live event win,
		// and no user action — not removing the song, not queue:sync — ever clears it).
		// The reaper has no catalog and no #emitStatus, which is why this hook used to hand-reimplement
		// the whole epilogue and drift from the two worker-hub copies (issue an earlier change shipped it SILENT).
		// It now calls the one shared epilogue directly — settle the gate, tell the room, log one
		// uniform line, reclaim scratch — with `cause: 'reaper'` so the operator can still grep this
		// path apart.
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

	// A play is recorded TWICE, deliberately, because the two answer different questions:
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

/**
 * The genuinely per-socket / per-frame inputs to a HubDeps bag — everything that is NOT derivable from
 * the shared app. server.ts owns these: the room broadcast sink, the authenticated singer on THIS
 * socket, the live membership snapshot, and the idempotency ledger. Everything else a hub call needs
 * is read straight off `app` by {@link buildHubDeps}.
 */
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
 * Assemble a complete {@link HubDeps} for one WS frame from the shared app plus the per-frame inputs.
 *
 * This is the SINGLE place the hub's optional hooks are wired to their live services, replacing the
 * hand-assembled bag that server.ts spelled out per frame (§3). The app-derived hooks —
 * listSingers -> app.singers, getSettings -> app.settings, onNowPlaying -> app.plays, onSang ->
 * app.singers, recordAdd -> app.popularity, onEntryRemoved -> cancelJobsForMedia, onEntryAdded ->
 * reprioritizeProcessForMedia — are filled HERE, so a new optional hook is wired in one place instead of
 * at every composition site. The optionality that genuinely varies per call (actorSingerId, the
 * membership snapshot, the ledger) is passed in via {@link HubDepsPerFrame}. The hubdeps-composition-
 * parity guard now asserts THIS literal fills every optional HubDeps key, so a dropped hook still reds.
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
		// An explicit remove of a processing song stops the process (subprocess kill + slot release + dedup-slot
		// free). Settles the media back to un-processed and tells the room so a search row stops showing a
		// process that is no longer running. No-ops when a shared process is still needed by another entry.
		onEntryRemoved: (mediaId: string, remainingEntries: QueueEntry[]) =>
			cancelJobsForMedia(mediaId, {
				jobs: app.jobs,
				toWorker: app.toWorker,
				remainingEntries,
				now: app.now,
				mediaById: app.mediaById,
				broadcast: perFrame.broadcast
			}),
		// The add-side mirror: a process filed at NO_QUEUE_PRIORITY (process POST beat the queue add over
		// a reconnecting socket) is pulled to the turn's rotation position and dispatch kicked, so it stops
		// sorting behind the lyrics backfill forever. No-ops with no process in flight (starvation half).
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
