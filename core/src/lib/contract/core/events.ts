// The wire contract between core, phones, TV and workers. See docs/ARCHITECTURE.md §3, §7.

import type { Media, QueueEntry, Singer, PlaybackState, JobType, SelectionRecord } from './types';
import type { ServerPatch, ClientCommand } from './ops';
import type { LyricsCandidate } from '../lyrics/lyrics';
import type { SongProfile } from '../process/song-profile';
import type { EffectiveSettings, TvBackgroundStyle } from './settings';

// THE TENANCY BOUNDARY for broadcasts. See docs/SERVER.md#authority-and-the-hub.
export function roomTopic(roomId: string): string {
	return `room:${roomId}`;
}

/** The served room's TELEVISIONS only. A separate pub/sub topic rather than a filter at send time: the phone client
 *  never subscribes to it, so it never hears a TV-only frame. `role=tv` is a client-supplied query param, so this
 *  keeps reactions off phones, not secret from the LAN; the payload (`singerId`, `kind`, `color`) is harmless. */
export function roomTvTopic(roomId: string): string {
	return `${roomTopic(roomId)}:tv`;
}

/** The whole allowed list for `room:react`, in the order the phone lays the buttons out. The pictures are bundled
 *  artwork (`ui/ReactionGlyph.svelte`), not emoji text, so a TV with no emoji font still draws them. */
export const REACTIONS = [
	{ id: 'clap', label: 'Clap' },
	{ id: 'fire', label: 'Fire' },
	{ id: 'laugh', label: 'Laugh' },
	{ id: 'heart', label: 'Love it' }
] as const;

export type ReactionKind = (typeof REACTIONS)[number]['id'];

export function isReactionKind(v: unknown): v is ReactionKind {
	return REACTIONS.some((r) => r.id === v);
}

export type MediaStatus =
	| 'queued'
	| 'downloading'
	| 'separating'
	| 'aligning'
	| 'ready'
	| 'failed'
	// A distinct TERMINAL status: `failed` would tell a guest their own deliberate act was a failure, and
	// any non-terminal value re-strands the row.
	| 'canceled';

/** IN ORDER — the one axis both sides position themselves on, so a second copy is how they drift.
 *  `failed` and `canceled` are absent: they are exits from the line, not stops on it. */
export const MEDIA_STAGES = ['queued', 'downloading', 'separating', 'aligning', 'ready'] as const;

export type MediaStage = (typeof MEDIA_STAGES)[number];

/** Position on `MEDIA_STAGES`, or -1 for a status that is not on the line (failed / canceled). */
export function mediaStagePosition(status: MediaStatus): number {
	return (MEDIA_STAGES as readonly string[]).indexOf(status);
}

// A singer safe to broadcast (no sessionToken).
export type PublicSinger = Omit<Singer, 'sessionToken'>;

/** The WebSocket close code for "this socket's singer left the room" (server.ts, on a Leave from any tab). The phone
 *  reads it as a session ending, not a dropped link, so it asks /api/me without showing "Reconnecting…". */
export const LEFT_CLOSE_CODE = 4001;
/** A `/tv` the host removed on the Screens page: it stops reconnecting and says so. Opened again, it is a new screen. */
export const TV_REMOVED_CLOSE_CODE = 4002;
/** A cookieless `/tv` turned away because the room has its fill of those. A screen with a cookie never is. */
export const TV_FULL_CLOSE_CODE = 4003;

// core -> all clients (broadcasts)
export type ServerEvent =
	| { type: 'queue:patch'; patch: ServerPatch }
	// Optional, so a client joining mid-party has the full picture immediately.
	| {
			type: 'queue:sync';
			rev: number;
			entries: QueueEntry[];
			singers?: PublicSinger[];
			// The QUEUED songs only; the library is fetched over HTTP.
			media?: Media[];
			// Measured LUFS of every song in the library, for the TV's loudness median.
			loudness?: number[];
			online?: string[];
			away?: string[];
			settings?: EffectiveSettings;
			// Whether any connected worker can make karaoke at the room's quality (`WorkerHub.canMake`, after a 10 s grace
			// on loss). A boolean only: no worker ids, hosts or counts. OMITTED means "no info", so a client keeps its own.
			canMake?: boolean;
			// Whether any connected worker can FETCH a search result (`WorkerHub.canFetch`, same grace). A library upload
			// needs no fetch, so a box with no yt-dlp can make while this is false. A boolean only, like `canMake`.
			canFetch?: boolean;
	  }
	| { type: 'playback:state'; state: PlaybackState; rev: number }
	| { type: 'nowplaying:changed'; current: QueueEntry | null; upNext: QueueEntry | null }
	// `unservable` separates "processing soon" from "stuck forever" — no connected worker advertises the
	// capability. See docs/SERVER.md#idempotency-and-the-process-cap.
	// `requestedBy` is the singer who ASKED for this work, when one did. The STATUS stays room-wide — every phone
	// needs it to draw the right row — but a notice whose imperative is "try again" belongs to the guest who asked,
	// and without this field every phone in the room was told to retry a song it had never heard of. ABSENT means
	// nobody in particular asked (an internal or admin-side process), which clients read as "tell everyone".
	| {
			type: 'media:status';
			mediaId: string;
			status: MediaStatus;
			pct: number;
			/** Seconds until ready; absent when unknown, and -1 when the job is well past it (`jobs/eta.ts`). */
			etaSec?: number;
			unservable?: boolean;
			requestedBy?: string;
			// On `failed` only: the song's row, so a phone that never fetched it can name it in the notice.
			media?: Media;
			// A failure the room was already told about, re-sent because its CAUSE changed (a maker joined): every
			// phone redraws the row, and nobody is told "try again" a second time.
			restated?: boolean;
	  }
	| { type: 'singer:joined'; singer: PublicSinger }
	| { type: 'singer:updated'; singer: PublicSinger }
	| { type: 'singer:left'; singerId: string }
	// FULL SNAPSHOTS, never deltas: an idempotent snapshot cannot drift after a dropped frame.
	| { type: 'singer:presence'; online: string[]; away: string[] }
	| { type: 'settings:changed'; settings: EffectiveSettings }
	| { type: 'op:reject'; clientOpId: string; reason: string }
	// TV-ONLY, published on `roomTvTopic`. `color` rides along so the TV draws the disc without a directory lookup.
	| { type: 'room:reacted'; singerId: string; kind: ReactionKind; color: string }
	// To the ORIGIN only: a transport command named a song that is no longer current, so nothing happened.
	// `singerOnly`: the song IS current, but its key and guide are its singer's and the sender is someone else.
	| { type: 'player:stale'; cmd: TargetedCommand['cmd']; singerOnly?: true }
	// To ONE TV socket, on connect and whenever its answer moves: `mine: false` is a copy, whose telemetry the server
	// ignores; `tvOnline: false` means the seat's screen has no live socket right now; `next`: this copy is the room's
	// TV, back mid-song, and takes the seat at the next song. See server/rooms/tv-seat.ts.
	| { type: 'tv:seat'; mine: boolean; tvOnline: boolean; next: boolean }
	// TV-ONLY, ~4 Hz: the seat's playhead as core received it (`serverAt`, core's ms clock), for copies to follow.
	| { type: 'tv:clock'; entryId: string; positionSec: number; serverAt: number }
	// To the ORIGIN only: the answer to its `tv:ping`, so a copy can learn its offset to core's clock.
	| { type: 'tv:pong'; t0: number; serverAt: number };

// phone/TV -> core. Every value is an ABSOLUTE target, clamped or allowlisted SERVER-side, and `null`
// clears the per-song override rather than meaning zero.
export type PlayerCommand =
	| { cmd: 'play' }
	| { cmd: 'pause' }
	// The TRANSPORT names the entry it was pressed on, and the server drops one that is no longer current: two
	// phones tapping skip at the end of a song must take one song, not the next singer's turn too.
	| { cmd: 'skip'; entryId: string }
	| { cmd: 'restart'; entryId: string }
	| { cmd: 'seek'; positionSec: number; entryId: string }
	// Clamped to ±MAX_KEY_SHIFT, and only accepted once the song's stems are ready. Per-song, so it names its
	// song too: a late key tap must not re-pitch the next singer's song over their On deck preset.
	| { cmd: 'key'; semitones: number; entryId: string }
	| { cmd: 'background'; style: TvBackgroundStyle | null }
	// 0..1, and only accepted for a song that actually has a vocals stem.
	| { cmd: 'guide'; level: number | null; entryId: string };

/** The commands that name the song they were pressed on; the server drops one naming a song that has gone. */
export type TargetedCommand = Extract<PlayerCommand, { entryId: string }>;

/** How long the TV's Skipped notice stands. SHARED because the server holds the next song for it: the TV releases the
 *  hold with `tv:telemetry` `resume` when the notice clears, and the server releases it itself if that never comes. */
export const SKIP_NOTICE_MS = 4000;

export type ClientEvent =
	| { type: 'queue:command'; command: ClientCommand }
	| { type: 'player:command'; command: PlayerCommand }
	| { type: 'tv:telemetry'; positionSec: number; status: string; entryId?: string }
	// "Make this the TV": the sending screen takes the room's seat.
	| { type: 'tv:claim' }
	// A copy timing its offset to core's clock; `t0` is echoed back in `tv:pong`.
	| { type: 'tv:ping'; t0: number }
	// A copy's own distance from the TV's clock (copy minus TV, ms), every few seconds, for the host's Screens page.
	| { type: 'tv:drift'; ms: number }
	| { type: 'hello'; lastRev: number }
	// Fire-and-forget: a dropped or rate-limited tap gets no reply. See server/realtime/reactions.ts.
	| { type: 'room:react'; kind: ReactionKind };

/**
 * One separation model a worker offers, for rendering a picker.
 *
 * METADATA ONLY — routing does not read this. A model is routed on the capability token
 * `stems:model:<token>` that arrives in the same frame's `capabilities`, which the existing dispatch
 * already matches on; a published score is not a routing input.
 */
export interface SeparatorOffer {
	/** Stable token, recorded in `job_attempts.model` and sent back as `JobParams.model`. */
	token: string;
	label: string;
	/** `VR` / `MDX` / `MDXC` / `Demucs`. */
	architecture: string;
	/**
	 * UPSTREAM'S published figure, not this project's measurement, and not comparable to
	 * `docs/benchmarks/stem-separation` — those are plain SDR, these are museval BSS-eval on tracks we did
	 * not choose. Fine for ranking a hundred unknowns; do not label it "measured" in the UI.
	 */
	upstreamInstrumentalSdr?: number;
	upstreamVocalsSdr?: number;
	/**
	 * `declared` when the model's own metadata names its stems, `unknown` when the worker determines them
	 * from the audio. Either way the worker VERIFIES from the audio before publishing — this says only
	 * whether there was a hint to start from, which is worth surfacing for an exotic pick.
	 */
	roleSource?: 'declared' | 'unknown';
}

/**
 * A `SeparatorOffer` unioned across the connected fleet, for a picker.
 *
 * Lives in the contract rather than beside the union that builds it, because the settings PAGE renders it —
 * and a component importing from `$lib/server` is what SvelteKit's server-module guard exists to stop.
 */
export interface OfferedModel extends SeparatorOffer {
	/** How many connected workers advertised this token. 1 means picking it pins the job to one box. */
	workerCount: number;
}

// The dial-home protocol: workers connect TO the core. The frame NAMES are mirrored in the worker's
// `protocol.py` and a parity guard holds the two unions equal.

// worker -> core
export type WorkerMessage =
	| {
			type: 'worker:hello';
			workerId: string;
			authToken?: string;
			capabilities: string[];
			concurrency: number;
			version: string;
			host?: WorkerHost;
			/** The worker's resolved profile. UNTRUSTED like the rest of the frame: `#onHello` keeps only the
			 *  well-shaped fields (`workerProfile`). */
			backend?: unknown;
			device?: unknown;
			threads?: unknown;
			demucsJobs?: unknown;
	  }
	| {
			/**
			 * The selectable separation models a worker can run, sent AFTER `worker:hello` rather than in it.
			 *
			 * WHY A SECOND FRAME. Enumerating the worker's model zoo probes torch, the ONNX runtime and the
			 * accelerator, and downloads a catalogue on first run — measured at 4.8 s. Registration must not
			 * wait for a picker's contents, so the worker joins with its base capabilities and follows up.
			 *
			 * `capabilities` REPEATS the full set rather than sending a delta, so applying it is idempotent: a
			 * dropped or duplicated frame cannot leave a half-updated view. Replace, never merge.
			 */
			type: 'worker:catalogue';
			workerId: string;
			capabilities: string[];
			separators: SeparatorOffer[];
	  }
	| { type: 'worker:heartbeat'; workerId: string; slotsFree: number; runningJobIds: string[] }
	| { type: 'job:accept'; workerId: string; jobId: string }
	| { type: 'job:reject'; workerId: string; jobId: string; reason: string }
	| { type: 'job:progress'; workerId: string; jobId: string; stage: MediaStatus; pct: number; etaSec?: number }
	| {
			type: 'job:complete';
			workerId: string;
			jobId: string;
			mediaUri: string;
			artifacts?: JobArtifacts;
			facts?: ResolvedFacts;
			/** Per-stage wall clock for this job, in the order the stages ran. */
			stages?: StageTiming[];
			/** Absent on every non-align job, and on an align that made no choice among versions. */
			selection?: SelectionRecord;
			/**
			 * The ordered decision history the worker's state machine produced. Also streamed live as
			 * `job:state`; this is the belt-and-braces copy for a worker that reported nothing until the end.
			 */
			trail?: Array<Record<string, unknown>>;
	  }
	| { type: 'job:failed'; workerId: string; jobId: string; error: string; retryable: boolean }
	| {
			/**
			 * WHERE THE WORKER'S STATE MACHINE IS, and why it moved. Distinct from `job:progress` on purpose: a
			 * stage and a percentage cannot express "re-aligning, attempt 2, knob vocals->mix, because coverage
			 * was 0.42". That explanation previously went to the worker's stdout, and a process log rotates —
			 * putting it on the wire is what makes "why did this job publish these lyrics" answerable later.
			 *
			 * Appended to the job's trail and persisted with its attempt. Diagnostic only: it never changes a
			 * job's status, so a lost frame costs an explanation rather than correctness.
			 */
			type: 'job:state';
			workerId: string;
			jobId: string;
			state: string;
			attempt: number;
			knob?: string;
			verdict?: string;
			why?: string;
	  }
	| {
			/**
			 * "Do I still own these?" — the PULL half of the ownership guard.
			 *
			 * A push (`job:revoked`) alone cannot close the window: a disconnect DROPS pushed frames, and a
			 * disconnect is precisely what expires a lease and causes a reassignment. So the one event that
			 * revokes a job is the same event that hides the revocation. The worker re-asks on every reconnect.
			 */
			type: 'job:claim';
			workerId: string;
			jobIds: string[];
	  };

/** What ACTUALLY ran, which differs routinely from what was asked. Every field optional, so a step
 *  reports only the axes that apply. See docs/SERVER.md#what-the-worker-is-told. */
export interface ResolvedFacts {
	engine?: string;
	model?: string;
	backend?: string;
	device?: string;
	asrModel?: string;
	syncMode?: string;
	/** An align job's reason for publishing no lyrics, one of `LYRICS_NOTES`; core drops anything else. */
	lyricsNote?: string;
}

/** What a worker RESOLVED for itself at boot. Stamped on every attempt the worker is assigned, so each
 *  `job_attempts` row says which hardware path it ran on. Names and counts only — never a hostname or a path. */
export interface WorkerProfile {
	/** The separator backend: `torch` or `mlx`. */
	backend?: string;
	/** The torch device (`cpu`, `cuda`, `mps`). An align job's completion overwrites it on its own row with
	 *  the device its transcriber ran on, which is `cpu` on a Mac. */
	device?: string;
	/** torch's intra-op threads in the worker process: what in-process torch work uses (alignment, the song
	 *  profile, diarization). NOT stems, which torch demucs runs in its own subprocess, nor whisperx, which
	 *  sets its own. */
	threads?: number;
	/** How many tracks torch demucs separates at once (its `-j`), the knob that does move stems speed.
	 *  Shown on /metrics only; the worker sends none until #1051 lands. */
	demucsJobs?: number;
}

/** The SPLIT the core cannot see: only the worker observes a stage transition. */
export interface StageTiming {
	stage: string;
	ms: number;
}
/** EVERY field optional, because a diagnostic must never fail a handshake, and every field is a
 *  MEASUREMENT rather than a setting. See docs/SERVER.md#what-the-worker-is-told. */
export interface WorkerHost {
	platform?: string;
	machine?: string;
	python?: string;
	cpuCount?: number; // EFFECTIVE, post-cgroup — never the host's total
	torch?: string;
	/** Superseded by `accelerator`, but derived from the same probe so the two cannot disagree. */
	cuda?: boolean;
	/** WHICH accelerator, not merely whether CUDA is present: ROCm masquerades as `cuda`. */
	accelerator?: 'cuda' | 'rocm' | 'xpu' | 'mps' | 'cpu';
	deviceName?: string;
	deviceCount?: number;
	memoryBytes?: number | null;
	vramBytes?: number | null; // physical capacity, not free memory
	/** A cgroup limit is in force — the difference between a small box and a sliced one. */
	contained?: boolean;
}

// Sent verbatim in `worker:welcome`.
export type MediaStoreConfig =
	{ kind: 'local' } | { kind: 'object'; bucket: string; endpoint?: string; region?: string; prefix?: string };

/**
 * ONE flat optional bag, so an unknown key never breaks an older worker. `artist`/`track` are the
 * CONFIDENCE-GATED canonicals, never the raw uploader and title; `language` is deliberately ABSENT,
 * because a guessed one is worse than letting ASR detect it.
 */
export interface JobParams {
	/** DECLARED, never inferred from the URI's shape. See docs/SERVER.md#what-the-worker-is-told. */
	fetcher?: string;
	model?: string; // separation model/checkpoint token (stems) — resolved by the worker engine
	engine?: string; // separation engine id (stems): 'demucs' | 'roformer' | 'ensemble'
	targetKey?: string; // requested key shift, if a job ever pre-renders one
	artist?: string; // canonical artist for a lyrics lookup; absent when the parse wasn't confident
	track?: string; // canonical title for a lyrics lookup; absent when the parse wasn't confident
	/** NOT a lookup key — it RANKS the records a search returns, which is how a version with a guest verse
	 *  is told from one without. */
	artistCredit?: string;
	album?: string;
	durationSec?: number; // narrows an LRCLIB match and bounds line-sync fallback timings
	/** Optional on the wire, so an older core still produces valid params; the worker's own defaults are
	 *  these same values. */
	asrModel?: string;
	syncMode?: string;
	/** A HUMAN re-pick: the worker SHORT-CIRCUITS grading and re-times this exact candidate. */
	pinnedRef?: string;
	/** PASTED lyrics no provider had. `pinnedRef` is the key it is written under, so the two travel together. */
	pinnedText?: string;
	/** The document on screen when the paste was pinned: its line timings seed the re-time. See docs/SERVER.md#lyrics-fixes. */
	pinnedFrom?: string;
	/** The watch URL of a song whose kept original is the job's `local` source: the fallback for a worker
	 *  that cannot see the media volume, which downloads (and fetches captions) from here instead. */
	remoteUri?: string;
	/** The kept original's size at fetch; a file of any other size is not trusted, and `remoteUri` is used. */
	originalBytes?: number;
}

// core -> worker
export type WorkerCommand =
	| {
			type: 'worker:welcome';
			heartbeatIntervalSec: number;
			ackTimeoutSec: number;
			mediaStore: MediaStoreConfig;
			/**
			 * The container the worker must write PUBLISHED stems in. CORE'S DECISION, announced here rather
			 * than configured on the worker: core owns the storage layout, a row's extension is recorded
			 * forever, and a worker guessing differently produces a file that exists while its ref 404s
			 * (see `paths.ts` — "a mismatch is SILENT").
			 *
			 * NOT the worker's `ENCORE_STEM_FORMAT`, which is the SCRATCH container a separator writes and is
			 * legitimately `wav` to skip an encode on a CPU-bound box.
			 *
			 * Additive and safe for older workers: they parse this frame field-by-field with `msg.get()` and
			 * ignore keys they do not know.
			 */
			publishStemFormat: string;
	  }
	| {
			type: 'job:assign';
			jobId: string;
			processingId: string;
			mediaId: string;
			jobType: JobType;
			sourceUri: string;
			params: JobParams;
	  }
	| { type: 'job:cancel'; jobId: string; reason: string }
	| {
			/**
			 * PUSHED the moment a job stops belonging to a worker — a reaper requeue, a reassignment. Closes the
			 * race continuously, which a poll cannot: the reassignment happens at a moment nobody chose.
			 */
			type: 'job:revoked';
			jobId: string;
			reason: string;
	  }
	| {
			/**
			 * The answer to `job:claim`, partitioned three ways.
			 *
			 * `unknown` is NOT folded into `revoked`, and the distinction is load-bearing: a job the core has no
			 * row for means the worker is running something core never recorded — a real desync worth surfacing —
			 * whereas `revoked` is an ordinary reassignment. Both forbid publishing; only one is a bug.
			 */
			type: 'job:claim-ack';
			owned: string[];
			revoked: string[];
			unknown: string[];
	  }
	| { type: 'ping' };

export interface JobArtifacts {
	/** The FILES separation published. `guideMix` belongs here BECAUSE it is a file, and is a third entry
	 *  rather than a replacement. */
	stems?: { instrumental?: string; vocals?: string; guideMix?: string };
	/** A SIBLING of `stems`, never a member, and the NESTING is why it is declared rather than read
	 *  structurally. See docs/SERVER.md#what-the-worker-is-told. */
	songProfile?: SongProfile;
	/** Absent is the normal outcome. Applied under a never-regress rule — see
	 *  docs/SERVER.md#media-storage-and-paths. */
	annotation?: {
		source: string;
		mbid: string;
		artist: string;
		title: string;
		confidence: string;
	};
	/** `uri` is the worker's choice (`""` = it published nothing); `candidates` is every document it wrote, each
	 *  attempt it did not publish marked `selectable: false`. The shape is what the worker SENDS, not a guarantee:
	 *  `setMediaLyrics` reads it through `parseLyricsCandidates`. */
	lyrics?: { uri: string; candidates?: LyricsCandidate[] };
	pitch?: { uri: string }; // reference pitch-track JSON
	/** Nothing reads it today, but EVERY key the worker writes must be declared here. */
	source?: { audio: string };
	/** A fetch's kept download (`mediaUri`): its size, which later stages check before trusting the file. */
	original?: { bytes: number };
}
