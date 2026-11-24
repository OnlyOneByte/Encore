// The seam between SvelteKit routes and the WS hub, which share ONE Bun process, so this module-level instance is deliberately the single source of truth. See docs/SERVER.md#authority-and-the-hub.

import { AuthoritativeState } from './state/store';
import { SingerRepository } from './singers/repository';
import { PeopleRepository } from './people/repository';
import { dailyPersonPrune, pruneIdlePeople } from './people/keep';
import { HostKey } from './host-key';
import { RoomRepository } from './rooms/repository';
import { PresenceTracker } from './realtime/presence';
import { PlayTracker, bumpPlay } from './media/plays';
import { openDb, defaultDbPath, type DB } from './db/index';
import { runMigrations, hydrate } from './db/migrate';
import { sqlitePersistence } from './state/persistence';
import { SettingsRepository } from './state/settings-repository';
import { LocalLibrary, scanLibrary } from './media/local';
import { ffmpegDurationProbe } from './media/duration';
import { YouTubeResolver } from './media/youtube';
import { innerTubeMusicSearch } from './media/ytmusic';
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
	evictSong,
	derivedBytesOf,
	transcodeDiagnostics
} from './media/retention';
import { needsLyricsBackfill, BACKFILL_PRIORITY } from './jobs/backfill';
import { backfillVocalsRefs } from './media/vocals-backfill';
import { ffmpegLoudnessProbe, isDigitalSilence } from './media/loudness';
import { safeMediaPath } from './media/local-files';
import { guideMixKey, mediaRoot } from './media/paths';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { markLyricsQueued, reportTerminalFailure } from './jobs/process';
import { reconcileStrandedGates } from './jobs/gate-reconcile';
import { deadTurns, DeadTurnWatch, type DeadTurn } from './jobs/dead-turns';
import { cancelJobsForMedia } from './jobs/cancel';
import { reprioritizeProcessForMedia } from './jobs/reprioritize-process';
import {
	readSidecar,
	updateSidecar,
	sidecarFromMedia,
	rebuildIndexFromMeta,
	backfillSidecars,
	canonicalsOf,
	readAllSidecars
} from './media/sidecar';
import { media as mediaTable } from './db/schema';
import { eq } from 'drizzle-orm';
import { createPopularityTracker, type PopularityTracker } from './media/popularity';
import { JobRepository } from './jobs/repository';
import { ATTEMPT_PRUNE_EVERY_MS, ATTEMPT_RETENTION_MS, AttemptLedger } from './jobs/attempts';
import { PlayLog } from './media/play-log';
import { NightLog } from './nights/repository';
import { dailyNightSweep, recordTurn, sweepGuestNights } from './nights/service';
import { JobReaper } from './jobs/reaper';
import { WorkerRegistry } from './jobs/registry';
import { WorkerHub } from './jobs/worker-hub';
import { runBootMaintenance, type BootTask } from './boot-maintenance';
import { reconcileOnReady } from './realtime/player';
import { orderingOf, syncEvent, type HubDeps, type Publish } from './realtime/hub';
import { resolveMediaStoreConfig, LocalMediaStore, type MediaStore, type MediaStoreConfig } from './media/store';
import { ObjectMediaStore, bunS3Client } from './media/object-store';
import { PendingDeletes } from './media/library-manage';
import { deleteMediaEntirely, type DeleteMediaResult } from './media/delete';
import type { ServerEvent, Media, WorkerCommand, QueueEntry } from '../contract';

export interface EncoreApp {
	db: DB;
	state: AuthoritativeState;
	singers: SingerRepository;
	people: PeopleRepository;
	hostKey: HostKey;
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
	/** Each singer's own turns, for their recap; never served to anyone else. */
	nights: NightLog;
	settings: SettingsRepository;
	reaper: JobReaper;
	workers: WorkerRegistry;
	workerHub: WorkerHub;
	mediaById: Map<string, Media>;
	/** Durable media catalog: write-behind store behind `mediaById` + the saved-karaoke library. */
	media: MediaRepository;
	localLibrary: LocalLibrary;
	youtube: YouTubeResolver;
	/** YouTube MUSIC search (InnerTube `songs` filter): real artist/album rows, same video identity. */
	ytmusic: YouTubeResolver;
	/** Spotify SEARCH / metadata source (annotator only; no acquisition). No-op when creds unset. */
	spotify: SpotifyResolver;
	popularity: PopularityTracker;
	mediaStore: MediaStore; // local volume (default) or object-store (S3/MinIO)
	mediaStoreConfig: MediaStoreConfig; // the resolved config sent to remote workers in worker:welcome
	/** Library deletes waiting out their Undo window. */
	pendingDeletes: PendingDeletes;
	publish: (e: ServerEvent) => void; // room broadcast; replaced by server.ts at boot
	/** Replaced by server.ts with the real socket map. */
	toWorker: (workerId: string, cmd: WorkerCommand) => void;
	/** Re-derives the membership snapshot the per-socket replies server.ts builds are made from — the
	 *  hello reply's `queue:sync`, via its per-frame `listOnline`/`listAway` — and re-broadcasts
	 *  `singer:presence`. NOT every `queue:sync`: the `onMediaReady` broadcast below builds its own from
	 *  `app.presence.online()`, the live map, with `away` omitted. Assigned by server.ts, which
	 *  OWNS that cache; call it after anything that changes who is in the room outside a socket edge.
	 *  OPTIONAL rather than no-op-by-default like {@link toWorker}, because the unit harnesses build their
	 *  app with `as unknown as EncoreApp` and a required field would be absent at runtime anyway — so every
	 *  caller must use `?.()` and get a real no-op instead of a crash. */
	refreshMembership?: () => void;
	/** Unbinds and closes every socket of a singer who left (src/lib/server/realtime/singer-sockets.ts). Assigned
	 *  by server.ts, which owns the sockets; OPTIONAL for the same reason as {@link refreshMembership}. */
	releaseSinger?: (singerId: string) => void;
	/** A room-wide `queue:sync`, so every screen re-reads a song row a route just changed. OPTIONAL as above. */
	syncRoom?: () => void;
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
	singers.hashLegacyTokens();
	const hostKey = new HostKey(db, process.env.ENCORE_ADMIN_TOKEN);
	hostKey.pruneExpired(Date.now());
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
				const next = (await updateSidecar(m.id, (prev) => sidecarFromMedia(m, Date.now(), prev)))!;
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

	/* THE CENSUS, and it belongs HERE, one line below the pass whose own sentence it finishes: `reconcileStrandedGates` already knows correctly that a gate will never close, and then never looks at the QUEUED ENTRIES its own settle just orphaned. Those entries are the dead turns — a turn the rotation holds a slot for and skips on every pass. READ-ONLY, after the reconcile so a gate it just settled is counted as what it now is, and never a repair: see the sweep further down for why nothing is written and nothing is broadcast. One line at boot plus the sweep's "what died while we were watching" is the whole operator story; about a hundred of these had accumulated across four separate days on the owner's own box with no line in any log, found only by a hand-written SQL join.
	   IT ALSO SITS ABOVE THE `lyrics backfill` BOOT PASS, and that one is not free: the pass enqueues an `align` job for every stems-ready song with no word-level timing, which is precisely a song whose lyrics gate is open — so a turn on one of those is counted dead HERE and revived seconds later, making this line briefly overstated rather than wrong-forever. Measured zero such songs on the owner's copy (every stems-ready row there has its lyrics gate closed), and the ordering is still the right one: the backfill is async and may be disabled by `ENCORE_LYRICS_BACKFILL=0`, so waiting on it would mean a census that sometimes never runs. The sweep below never repeats the overstatement: by the time it first runs the `align` job exists, `mediaWithOutstandingJob` sees it, and the song is simply not dead.
	   Wrapped like the pass above, for the same reason: a census must never be the thing that stops a party starting. */
	try {
		const outstanding = jobs.mediaWithOutstandingJob();
		const dead = deadTurns(state.entries, mediaById, (mediaId) => outstanding.has(mediaId));
		if (dead.length > 0) {
			const songs = new Set(dead.map((d) => d.mediaId)).size;
			const singers = new Set(dead.map((d) => d.singerId)).size;
			console.warn(
				`[core] ${dead.length} queued turn(s) over ${songs} song(s), held by ${singers} singer(s), can never be` +
					' made ready — nothing is in flight and no job is left that could finish them. The rotation skips each' +
					' one on every pass. A turn whose STEMS gate is open carries a retry on its /queue card; one whose' +
					' stems are ready but whose LYRICS gate is open does not — see the note on this predicate'
			);
		}
	} catch (err) {
		console.warn(`[core] dead-turn census skipped: ${(err as Error).message}`);
	}

	// ONE probe for the whole app, so a stem silent enough to refuse at publish time is silent enough to refuse a guide link. Declared ABOVE the boot passes and the hub that close over it: below them it is only initialised in time because every pass awaits first, which is a microtask-ordering accident rather than a guarantee.
	const loudness = ffmpegLoudnessProbe();

	// Declared ABOVE the boot passes for the same reason `loudness` is: the library-scan pass closes over it,
	// and reaching it through the app literal below would only work by microtask-ordering accident.
	const localLibrary = new LocalLibrary();

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
				const kept = new Set<string>();
				let keptBytes = 0;
				for (const c of candidates) {
					const side = await readSidecar(c.mediaId);
					c.lastUsedAt = side?.library.lastPlayedAt ?? side?.library.addedAt ?? 0;
					if (side?.library.keep) {
						kept.add(c.mediaId);
						keptBytes += c.derivedBytes;
					}
				}
				// Never strip a process out from under a live or queued entry: hydrate() restored the queue BEFORE this pass, so a restart mid-party with the cap set would otherwise evict the playing song. Kept songs are never evicted either.
				const protectedIds = new Set<string>([...entries.map((e) => e.mediaId), ...kept]);
				const currentMediaId = playback ? entries.find((e) => e.id === playback.currentEntryId)?.mediaId : undefined;
				if (currentMediaId) protectedIds.add(currentMediaId);
				const doomed = planEviction(candidates, cap, protectedIds);
				let freed = 0;
				for (const id of doomed) {
					const live = mediaById.get(id);
					if (!live) continue;
					freed += await evictSong(live, { jobs, upsert: (m) => mediaRepo.upsert(m) });
					// `canceled` is the quiet exit: open phones settle the song to not made and re-read Library.
					app.publish({ type: 'media:status', mediaId: id, status: 'canceled', pct: 0 });
				}
				if (doomed.length > 0) {
					console.log(
						`[core] retention: evicted derived artifacts for ${doomed.length} songs, freed ${(freed / 1e6).toFixed(1)} MB (cap ${(cap / 1e9).toFixed(1)} GB)`
					);
				}
				if (keptBytes > 0.9 * cap) {
					console.warn(
						`[core] retention: kept songs use ${(keptBytes / 1e9).toFixed(1)} of ${(cap / 1e9).toFixed(1)} GB; none of them is evicted` +
							(doomed.length ? `, so these unkept songs went instead: ${doomed.join(', ')}` : '')
					);
				}
			}
		},
		{
			name: 'local library scan',
			run: async () => {
				const dir = join(mediaRoot(), 'library');
				if (!existsSync(dir)) return;
				const probeDuration = ffmpegDurationProbe();
				const { tracks, skipped } = await scanLibrary(readdirSync(dir), async (ref) => {
					const abs = safeMediaPath(ref);
					return abs ? await probeDuration(abs) : null;
				});
				localLibrary.index(tracks);
				if (tracks.length > 0) console.log(`[core] library: indexed ${tracks.length} track(s) from ${dir}`);
				if (skipped.length > 0) {
					// Named, because "my song is not in search" is otherwise indistinguishable from a broken scan.
					console.warn(
						`[core] library: skipped ${skipped.length} file(s) with no readable duration (${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}) — a link that leads outside media, not decodable, or ffmpeg is missing`
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
		// No sidecar means not in the library (a plain search result): nothing to record against.
		updateSidecar(mediaId, (side) =>
			side ? { ...side, library: { ...side.library, ...bumpPlay(side.library, app.now()) } } : null
		).catch(() => {
			/* a lost play count is not worth a failed playback */
		});
	});

	const roomSync = () => roomSyncOf(app);

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
		// Whose "no maker" a worker's arrival makes untrue: the queued turns, read at that moment.
		queueEntries: () => state.entries,
		// Persist the ready flip, or the next boot re-processes a song already on disk.
		persistMedia: (mediaId) => {
			const m = mediaById.get(mediaId);
			if (m) mediaRepo.upsert(m);
		},
		// queue:sync FIRST, so clients get the new ready status BEFORE reconcile — otherwise the TV's cached media stays 'queued' until a later sync.
		onMediaReady: () => {
			app.publish(roomSync());
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
		// The maker verdict moved (a worker joined, or the last one has been gone the grace): every screen re-reads it.
		onMakerChange: () => app.publish(roomSync()),
		now: () => app.now()
	});

	/* THE DEAD-TURN SWEEP — READ-ONLY. `deadTurns` (jobs/dead-turns.ts) is the only thing in the system that can tell a turn the rotation will never play from one still cooking, because the test is "no live job can still close the gate" and the ledger that answers it is server-side. IT WRITES NOTHING AND BROADCASTS NOTHING, and both halves are deliberate:
	   · NOTHING IS WRITTEN because there is no inconsistency to repair — a dead turn's media is already `stem_status='none'` with its gate settled and nothing in flight, which is the state this system's own invariants say is correct. A write is also the one thing that cannot be taken back: the ~100 such entries on the owner's library copy are spread over ~80 distinct singers (round numbers deliberately — see dead-turns.ts on why the exact counts are not worth pinning in a comment), so a predicate bug that DELETED them destroys turns that many separate people asked for, where the same bug in a reader costs a wrong log line.
	   · NOTHING IS BROADCAST because the phone already derives this card itself, and better. Every `queue:sync` carries the media, so `queueCardKind`'s unacquired arm draws a --warn stalled card with an inline retry with no help from here. The only thing a `media:status` frame can say is 'failed', which flips that card to the ran-and-died copy, takes the RETRY off it (`onretry` is wired on the stalled kind alone) and toasts the holder about a turn that may have died days ago. The room is not the party missing a witness.
	   THE OPERATOR IS, and the census above says why. That is what this prints. */
	const deadTurnWatch = new DeadTurnWatch();
	const sweepDeadTurns = () => {
		const entries = state.entries;
		// The QUERY is what an empty queue skips, and only the query: `mediaWithOutstandingJob` is the sole I/O here, and with no queued entry there is no media to ask it about.
		let dead: DeadTurn[] = [];
		if (entries.length > 0) {
			const outstanding = jobs.mediaWithOutstandingJob();
			dead = deadTurns(entries, mediaById, (mediaId) => outstanding.has(mediaId));
		}
		// THE WATCH IS STEPPED ON EVERY PASS, INCLUDING AN EMPTY ONE, and returning above it would be the bug: its prune is one rule ("a media absent from this pass leaves both sets"), so skipping the call freezes the sets rather than clearing them — a song announced dead, drained from the queue, then re-queued and still dead would never announce again, and the silent first-pass adopt would be deferred to the first non-empty pass. Stepping with the empty set costs nothing and is the honest input: nothing is dead right now.
		// What the watch DECIDES is what counts as news: two consecutive passes (which closes the queue()→process() window with no clock) and once per media (which stops a 3s tick reprinting the standing population forever — that one is the boot census above, printed once).
		const newly = deadTurnWatch.step(new Set(dead.map((d) => d.mediaId)));
		if (newly.length === 0) return;
		// Turns, not just songs: one media holds ten of them on the owner's copy, and ten guests is a different sentence from one song.
		const turns = dead.filter((d) => newly.includes(d.mediaId)).length;
		console.warn(
			`[core] ${turns} queued turn(s) over ${newly.length} song(s) can no longer be made ready —` +
				` the rotation will skip them: ${newly.join(', ')}.` +
				' Retryable from the /queue card when the stems gate is the open one; see the predicate note for the' +
				' lyrics-gate case, which this census counts but the card cannot yet offer a way out of'
		);
	};

	let lastAttemptPrune = 0;
	let personPrune: (() => void) | null = null;
	let nightSweep: (() => void) | null = null;
	// A lease expiry may have changed capacity, so redispatch.
	const reaper = new JobReaper(jobs, {
		onReaped: () => workerHub.dispatch(),
		// EVERY tick, not only when sweep() reaps something: dispatch() is event-driven, so on an EMPTY fleet nothing else ever calls it and a job with no capable worker parks queued forever.
		// The dead-turn sweep rides the SAME tick rather than taking a timer of its own: core has exactly two periodic timers (this 3s reaper and MEMBERSHIP_SWEEP_MS in server.ts), and `onTick`'s own doc is written for precisely this class of purely time-based check. Dispatch runs FIRST because it is what fails an unservable job, so a turn that dies on this tick is seen dead on this tick rather than one tick later.
		onTick: () => {
			workerHub.dispatch();
			sweepDeadTurns();
			const now = app.now();
			if (now - lastAttemptPrune >= ATTEMPT_PRUNE_EVERY_MS) {
				lastAttemptPrune = now;
				attempts.pruneFinishedBefore(now - ATTEMPT_RETENTION_MS);
			}
			// Daily as well as at boot, so a core that runs for months still drops people whose phones all went idle.
			(personPrune ??= dailyPersonPrune(app, now))();
			(nightSweep ??= dailyNightSweep(app, now))();
			// Every tick: an unused grace's salt must not outlive its window (docs/SERVER.md#kept-people).
			app.people.clearExpiredGrace(now);
		},
		// A reaper-killed process reaches terminal `failed` without the worker reporting it, so it never hits worker-hub's onFailed. The SAME shared epilogue must run here, or the phone stays pinned on the processing percentage forever.
		// THE SINKS COME FROM THE HUB, not a bag built here. This call site used to pass `{ broadcast, mediaById }` and no `persist`, so a reaper-killed process settled its stem gate IN MEMORY ONLY while the stored row kept saying 'queued' — and `hydrateMediaCatalog` then won at the next boot, resurrecting the stranding the settle exists to prevent (repaired only incidentally, one boot later still, by `reconcileStrandedGates`). `TerminalFailureDeps.persist` is optional in the TYPE and required for durability, which is exactly the mistake a second assembly site invites; `WorkerHub.terminalFailureSinks()` is the one bag.
		onFailed: (job) => reportTerminalFailure(job, 'reaper', workerHub.terminalFailureSinks()),
		// The PUSH half of the ownership guard. A worker may be 40 minutes into a separation when its lease
		// expires; without this it finishes and publishes over whoever the job was reassigned to, and the last
		// writer wins with no error anywhere.
		onRevoked: (jobId, workerId, reason) => workerHub.revoke(jobId, workerId, reason)
	});

	app = {
		db,
		state,
		singers,
		people: new PeopleRepository(db),
		hostKey,
		rooms,
		activeRoomId,
		presence: new PresenceTracker(),
		plays,
		jobs,
		attempts,
		playLog,
		nights: new NightLog(db),
		settings,
		reaper,
		workers,
		workerHub,
		mediaById,
		media: mediaRepo,
		localLibrary,
		youtube: new YouTubeResolver(ytDlpSearch),
		ytmusic: new YouTubeResolver(innerTubeMusicSearch()),
		spotify: new SpotifyResolver((q, n) => spotifySearch(q, n)),
		popularity: createPopularityTracker(),
		mediaStore,
		mediaStoreConfig,
		pendingDeletes: new PendingDeletes((mediaId) => deleteSongNow(app, mediaId)),
		// No-op sinks until server.ts wires Bun.serve; routes and state still work without them.
		publish: () => {},
		toWorker: () => {},
		syncRoom: () => app.publish(roomSync()),
		now: () => Date.now()
	};

	// A restart drops every worker WS session, so an assigned/running row is orphaned. One-shot, before server.ts starts the reaper tick loop.
	app.reaper.recoverOnBoot();

	// A person whose every phone went idle can never come back, so their nights go too.
	pruneIdlePeople(app);
	sweepGuestNights(app);

	g[APP_KEY] = app;
	return g[APP_KEY]!;
}

/** A room-wide `queue:sync`, for the hub's own re-sends (a song turned ready, the maker verdict moved, a rename). */
export function roomSyncOf(app: EncoreApp): Extract<ServerEvent, { type: 'queue:sync' }> {
	return syncEvent(app.state, {
		mediaById: app.mediaById,
		listSingers: () => app.singers.listPublic(app.activeRoomId),
		listOnline: () => app.presence.online(),
		getSettings: () => app.settings.getEffective(app.activeRoomId),
		canMake: () => app.workerHub.canMake(),
		canFetch: () => app.workerHub.canFetch()
	});
}

/** The hard delete behind /api/delete-media and the library's Undo window. */
export function deleteSongNow(app: EncoreApp, mediaId: string, actorSingerId?: string): DeleteMediaResult {
	// The delete drives applyQueueOp + reconcileOnReady directly, not handleQueueCommand, so a no-op idempotency ledger is correct.
	const hub = buildHubDeps(app, {
		broadcast: (e) => app.publish(e),
		actorSingerId,
		listOnline: () => app.presence.online(),
		listAway: () => [],
		seenOp: () => false,
		hasOp: () => false
	});
	return deleteMediaEntirely(mediaId, {
		hub,
		media: app.media,
		cancel: { jobs: app.jobs, toWorker: app.toWorker, now: app.now }
	});
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
	/** Is a TV connected to this room? Only the socket path can know; see HubDeps.tvConnected. */
	tvConnected?: () => boolean;
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
		tvConnected: perFrame.tvConnected,
		getSettings: () => app.settings.getEffective(app.activeRoomId),
		canMake: () => app.workerHub.canMake(),
		canFetch: () => app.workerHub.canFetch(),
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
		onKeyChanged: (entryId) => app.nights.keyChanged(entryId),
		onTurnEnded: (entry, end, endedWith) => recordTurn(app, entry, end, endedWith),
		isDeleting: (mediaId) => app.pendingDeletes.has(mediaId),
		actorSingerId: perFrame.actorSingerId,
		seenOp: perFrame.seenOp,
		hasOp: perFrame.hasOp
	};
}
