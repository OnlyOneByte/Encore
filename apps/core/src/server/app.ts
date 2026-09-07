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
import { existsSync } from 'node:fs';
import { markLyricsQueued, reportTerminalFailure } from './jobs/make-karaoke';
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
import { orderingOf, syncEvent } from './realtime/hub';
import { resolveMediaStoreConfig, LocalMediaStore, type MediaStore, type MediaStoreConfig } from './media/store';
import { ObjectMediaStore, bunS3Client } from './media/object-store';
import type { ServerEvent, Media, WorkerCommand } from '@encore/shared';

export interface EncoreApp {
	db: DB;
	state: AuthoritativeState;
	singers: SingerRepository;
	/** Room lifecycle: create a party (mint id + join code) and look one up by code. */
	rooms: RoomRepository;
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
	/** Room-level separator settings: the engine/model a cook uses + the upgrade policy. */
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
	const state = new AuthoritativeState(sqlitePersistence(db), 250, () =>
		orderingOf({ getSettings: () => settings.getEffective(), listSingers: () => singers.listPublic() })
	);
	const { entries, playback } = hydrate(db);
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
	if (introEnv !== undefined && !settings.hasRoom()) {
		const ms = Math.max(0, Number(introEnv));
		settings.setRoom(
			Number.isFinite(ms) && ms === 0 ? { songIntroEnabled: false } : { songIntroEnabled: true, songIntroMs: ms }
		);
	}
	const workers = new WorkerRegistry();
	const mediaById = new Map<string, Media>();
	const { store: mediaStore, config: mediaStoreConfig } = buildMediaStore();

	// Hydrate the runtime catalog from the durable store BEFORE anything reads it. Without this
	// a restart forgot every song title (a hydrated queue entry rendered as a raw id) and re-cooked
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
					// ...and into the RUNTIME map, not just the index. hydrateMediaCatalog above ran
					// synchronously at boot while this pass is async, so mirroring only to the DB left every
					// in-memory Media without its canonicals for the whole process lifetime — invisible to
					// browse (which queries the index) but not to anything reading mediaById. It surfaced as an
					// align job dispatched with `artist` but no `track`. Patch only these fields: a live entry
					// may have flipped to cooking since hydrate, and a wholesale replace would undo that.
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
				// Link the vocals stem for songs cooked while the core was dropping that artifact. Pure
				// filesystem work — no job, no worker, no cpu — so unlike the lyrics backfill there is nothing
				// to queue and nothing for a singer's live cook to compete with. A silent stem is counted and
				// deliberately NOT linked: see media/loudness.ts.
				const probe = ffmpegLoudnessProbe();
				const res = await backfillVocalsRefs(mediaById.values(), {
					resolve: (ref) => safeMediaPath(ref),
					exists: (abs) => existsSync(abs),
					measure: async (abs) => {
						const reading = await probe(abs);
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
						`[core] guiding track: ${res.silent} song(s) have a SILENT vocals stem — not linked, re-cook to fix`
					);
				}
				if (res.missing > 0) {
					console.log(
						`[core] guiding track: ${res.missing} cooked song(s) have no vocals stem on disk (re-cook to add one)`
					);
				}
			}
		},
		{
			name: 'lyrics backfill',
			// Set ENCORE_LYRICS_BACKFILL=0 to skip (e.g. mid-party on a slow box).
			enabled: () => process.env.ENCORE_LYRICS_BACKFILL !== '0',
			run: async () => {
				// Songs cooked before the align pipeline existed have no align job and no way to get one, so
				// the library's existing catalog would never gain lyrics. Enqueued at the LOWEST priority so a
				// singer's live cook always jumps the whole backfill queue, and dedup on (mediaId, jobType)
				// makes a restart idempotent.
				const need = needsLyricsBackfill(mediaById.values());
				for (const id of need) {
					jobs.enqueue(id, 'align', BACKFILL_PRIORITY, Date.now());
					markLyricsQueued(id, mediaById);
				}
				if (need.length > 0) {
					console.log(
						`[core] lyrics backfill: queued ${need.length} align job(s) for already-cooked songs` +
							' (lowest priority; ENCORE_LYRICS_BACKFILL=0 to skip)'
					);
					app.workerHub.dispatch();
				}
			}
		},
		{
			name: 'recompress legacy stems',
			run: async () => {
				// Recompress legacy stems in place. Songs cooked before the audio policy carry WAV stems ~8x
				// larger than a cook produces today; the bytes are already here, so this needs no download and
				// no Demucs run, and the song never leaves the library. Eviction would have been the wrong
				// tool: it would drop those songs until re-cooked.
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
				// Never strip a cook out from under a live or queued entry. hydrate() (above) restored the
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
					// back to un-cooked: rotation stops treating it as playable, a re-request re-cooks it
					live.instrumentalRef = undefined;
					live.vocalsRef = undefined;
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
	// failure is named and does not skip the rest (issue #446 defect 1).
	void runBootMaintenance(bootTasks, (msg) => console.warn(`[core] ${msg}`));

	// The app object is built below; the hub's sinks (toWorker/broadcast) read THROUGH the app so
	// server.ts can replace the real socket map at boot without rebuilding the hub.
	const app: EncoreApp = {
		db,
		state,
		singers,
		rooms,
		presence: new PresenceTracker(),
		// Set just below — the sink needs `app` to reach the media catalog.
		plays: null as never,
		jobs,
		attempts,
		playLog,
		settings,
		reaper: null as never, // set below (needs onReaped → workerHub.dispatch)
		workers,
		workerHub: null as never, // set below (needs app.toWorker/publish indirection)
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
	//   - the SIDECAR carries the authoritative lifetime total and the recency retention's LRU reads.
	//     One small JSON write per song, no migration.
	//   - the LOG carries one row per performance, which is the only thing that can answer WHEN. A
	//     counter cannot produce a trend line, and queue_entries is wiped on every flush and on boot.
	// The log write is synchronous and tiny (one indexed insert); the sidecar write stays
	// fire-and-forget because it is file I/O and bookkeeping must never delay the song starting.
	app.plays = new PlayTracker((mediaId, entryId) => {
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

	app.workerHub = new WorkerHub({
		jobs,
		attempts,
		registry: workers,
		mediaById,
		toWorker: (workerId, cmd) => app.toWorker(workerId, cmd),
		broadcast: (e) => app.publish(e),
		// remote workers pull source / push stems via this store config (local volume or S3/MinIO)
		mediaStore: mediaStoreConfig,
		// A stems/upgrade job carries the room's chosen engine+model, read live at assign time. EFFECTIVE
		// (global+room) so the room's downward-only quality ceiling actually reaches dispatch — the hub
		// folds resolveCookSeparator over this before handing the pure dispatch layer its settings.
		getSettings: () => app.settings.getEffective(),
		// A cooked song is durable — persist the ready flip (instrumental key + lyrics + pitch)
		// so the next boot lists it in the karaoke library instead of re-cooking it.
		persistMedia: (mediaId) => {
			const m = mediaById.get(mediaId);
			if (m) mediaRepo.upsert(m);
		},
		// When a cooked song flips to ready, reconcile playback (start if the room idled / preload) —
		// the held entry slots back at its fair position. Broadcast a fresh queue:sync FIRST
		// so every client updates its media catalog with the now-ready song's new sourceRef (the
		// instrumental key) + ready status — otherwise the TV's cached media stays 'queued' and sits
		// on the WAITING screen (the "big gap" between cook-finish and playback) until a later sync.
		onMediaReady: () => {
			app.publish(
				syncEvent(state, {
					mediaById,
					listSingers: () => app.singers.listPublic(),
					listOnline: () => app.presence.online(),
					getSettings: () => app.settings.getEffective()
				})
			);
			// listSingers + getSettings are not optional garnish here: reconcileOnReady picks what plays
			// next, so without them it would pick using fair rotation while every client is looking at a
			// queue ordered by whatever the room actually chose.
			reconcileOnReady({
				state,
				publish: (e) => app.publish(e),
				mediaById,
				listSingers: () => app.singers.listPublic(),
				getSettings: () => app.settings.getEffective(),
				onNowPlaying: (e) => app.plays.onNowPlaying(e),
				onSang: (singerId) => app.singers.markSang(singerId, app.now())
			});
		},
		now: () => app.now()
	});

	// When the reaper requeues/fails a job (lease expiry), capacity may have changed → redispatch.
	app.reaper = new JobReaper(jobs, {
		onReaped: () => app.workerHub.dispatch(),
		// A reaper-killed cook (worker box died, attempts exhausted) reaches terminal `failed` without
		// the worker reporting it, so it never hits #onFailed. The reaper has no catalog, so it hands
		// the job up and we do here EXACTLY what the reported (#onFailed) and unservable-TTL paths do —
		// otherwise a reaper-killed cook is completely silent (issue #303): the gate settles but the
		// room is told nothing, so every phone that watched it cook stays pinned on "Making karaoke… N%"
		// with no Sing button, for the life of the page (displayReadiness lets the last live event win,
		// and no user action — not removing the song, not queue:sync — ever clears it).
		// The reaper has no catalog and no #emitStatus, which is why this hook used to hand-reimplement
		// the whole epilogue and drift from the two worker-hub copies (issue #303 shipped it SILENT).
		// It now calls the one shared epilogue directly — settle the gate (#90), tell the room, log one
		// uniform line, reclaim scratch — with `cause: 'reaper'` so the operator can still grep this
		// path apart (issue #451).
		onFailed: (job) => reportTerminalFailure(job, 'reaper', { broadcast: (e) => app.publish(e), mediaById })
	});
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
