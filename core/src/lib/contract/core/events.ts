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

// core -> all clients (broadcasts)
export type ServerEvent =
	| { type: 'queue:patch'; patch: ServerPatch }
	// Optional, so a client joining mid-party has the full picture immediately.
	| {
			type: 'queue:sync';
			rev: number;
			entries: QueueEntry[];
			singers?: PublicSinger[];
			media?: Media[];
			online?: string[];
			away?: string[];
			settings?: EffectiveSettings;
	  }
	| { type: 'playback:state'; state: PlaybackState; rev: number }
	| { type: 'nowplaying:changed'; current: QueueEntry | null; upNext: QueueEntry | null }
	// `unservable` separates "processing soon" from "stuck forever" — no connected worker advertises the
	// capability. See docs/SERVER.md#idempotency-and-the-process-cap.
	| { type: 'media:status'; mediaId: string; status: MediaStatus; pct: number; etaSec?: number; unservable?: boolean }
	| { type: 'singer:joined'; singer: PublicSinger }
	| { type: 'singer:updated'; singer: PublicSinger }
	| { type: 'singer:left'; singerId: string }
	// FULL SNAPSHOTS, never deltas: an idempotent snapshot cannot drift after a dropped frame.
	| { type: 'singer:presence'; online: string[]; away: string[] }
	| { type: 'settings:changed'; settings: EffectiveSettings }
	| { type: 'op:reject'; clientOpId: string; reason: string };

// phone/TV -> core. Every value is an ABSOLUTE target, clamped or allowlisted SERVER-side, and `null`
// clears the per-song override rather than meaning zero.
export type PlayerCommand =
	| { cmd: 'play' }
	| { cmd: 'pause' }
	| { cmd: 'skip' }
	| { cmd: 'restart' }
	| { cmd: 'seek'; positionSec: number }
	// Clamped to ±MAX_KEY_SHIFT, and only accepted once the song's stems are ready.
	| { cmd: 'key'; semitones: number }
	| { cmd: 'background'; style: TvBackgroundStyle | null }
	// 0..1, and only accepted for a song that actually has a vocals stem.
	| { cmd: 'guide'; level: number | null };

export type ClientEvent =
	| { type: 'queue:command'; command: ClientCommand }
	| { type: 'player:command'; command: PlayerCommand }
	| { type: 'tv:telemetry'; positionSec: number; status: string; entryId?: string }
	| { type: 'hello'; lastRev: number };

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
	/** `uri` is the single best artifact; `candidates` is the full set, one per TEXT SOURCE. */
	lyrics?: { uri: string; candidates?: LyricsCandidate[] };
	pitch?: { uri: string }; // reference pitch-track JSON
	/** Nothing reads it today, but EVERY key the worker writes must be declared here. */
	source?: { audio: string };
}
