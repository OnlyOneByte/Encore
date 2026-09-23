// WebSocket event vocabulary — the wire contract between core, phones, TV, and workers.
// See docs/ARCHITECTURE.md.

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
	// A process that STOPPED because someone removed the song. A distinct TERMINAL status: reusing `failed`
	// tells a guest their own deliberate act was a failure, and any non-terminal value re-strands the row.
	| 'canceled';

/** The five stops of a process, IN ORDER — the one axis both sides position themselves on, so a second copy is
 *  how they drift. `failed` and `canceled` are absent: they are exits from the line, not stops on it. */
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
	// Optional directories and snapshots, so a client joining mid-party has the full picture immediately.
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
	// `unservable` = queued but no connected worker advertises its capability, which separates "processing
	// soon" from "stuck forever". See docs/SERVER.md#idempotency-and-the-process-cap.
	| { type: 'media:status'; mediaId: string; status: MediaStatus; pct: number; etaSec?: number; unservable?: boolean }
	| { type: 'singer:joined'; singer: PublicSinger }
	| { type: 'singer:updated'; singer: PublicSinger }
	| { type: 'singer:left'; singerId: string }
	// FULL SNAPSHOTS, never deltas: an idempotent snapshot cannot drift after a dropped frame.
	| { type: 'singer:presence'; online: string[]; away: string[] }
	| { type: 'settings:changed'; settings: EffectiveSettings }
	| { type: 'op:reject'; clientOpId: string; reason: string };

// phone/TV -> core. Every value is an ABSOLUTE target, clamped or whitelisted SERVER-side, and `null` clears
// the per-song override rather than meaning zero. See docs/SERVER.md#authority-and-the-hub.
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

// The dial-home worker protocol: workers connect TO the core, all frames JSON `{ type, ...payload }`. The
// frame NAMES are mirrored in the worker's `protocol.py` and a parity guard holds the two unions equal.
// See docs/ARCHITECTURE.md §7.

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
			/** What the worker ACTUALLY resolved and ran. See ResolvedFacts. */
			facts?: ResolvedFacts;
			/** Per-stage wall clock for this job, in the order the stages ran. */
			stages?: StageTiming[];
			/** WHY the published lyric was chosen — the align step's variant-pick provenance. Absent on
			 *  every non-align job and on an align job that made no choice among versions. */
			selection?: SelectionRecord;
	  }
	| { type: 'job:failed'; workerId: string; jobId: string; error: string; retryable: boolean };

/** What the worker ACTUALLY ran, which differs routinely from what it was asked. Every field optional, so a
 *  step reports only the axes that apply. See docs/SERVER.md#what-the-worker-is-told. */
export interface ResolvedFacts {
	engine?: string;
	model?: string;
	backend?: string;
	device?: string;
	asrModel?: string;
	syncMode?: string;
}

/** How long one stage took — the SPLIT the core cannot see, since only the worker observes a transition. */
export interface StageTiming {
	stage: string;
	ms: number;
}
/** The box a worker runs on. Best-effort with EVERY field optional, because a diagnostic must never fail a
 *  handshake, and every field is a MEASUREMENT rather than a setting. See
 *  docs/SERVER.md#what-the-worker-is-told. */
export interface WorkerHost {
	platform?: string;
	machine?: string;
	python?: string;
	cpuCount?: number; // EFFECTIVE, post-cgroup — never the host's total
	torch?: string;
	/** Superseded by `accelerator`, but derived from the same probe so the two cannot disagree. */
	cuda?: boolean;
	/** WHICH accelerator, not merely whether CUDA is present: ROCm masquerades as `cuda`, so a boolean
	 *  reports an AMD card as NVIDIA. */
	accelerator?: 'cuda' | 'rocm' | 'xpu' | 'mps' | 'cpu';
	deviceName?: string;
	deviceCount?: number;
	memoryBytes?: number | null;
	vramBytes?: number | null; // physical capacity, not free memory
	/** A cgroup limit is in force — the difference between a small box and a sliced one. */
	contained?: boolean;
}

// Where workers pull source and push stems. Sent verbatim in `worker:welcome`; see docs/ARCHITECTURE.md §2.
export type MediaStoreConfig =
	{ kind: 'local' } | { kind: 'object'; bucket: string; endpoint?: string; region?: string; prefix?: string };

/**
 * Per-job inputs the core derives and the worker consumes. ONE flat optional bag, so an unknown key never
 * breaks an older worker. `artist`/`track` are the CONFIDENCE-GATED canonicals and never the raw uploader and
 * title; `language` is deliberately ABSENT, because a guessed one is worse than letting ASR detect it.
 */
export interface JobParams {
	/** How the worker obtains `sourceUri` — DECLARED, never inferred from the URI's shape. See
	 *  docs/SERVER.md#what-the-worker-is-told. */
	fetcher?: string;
	model?: string; // separation model/checkpoint token (stems) — resolved by the worker engine
	engine?: string; // separation engine id (stems): 'demucs' | 'roformer' | 'ensemble'
	targetKey?: string; // requested key shift, if a job ever pre-renders one
	artist?: string; // canonical artist for a lyrics lookup; absent when the parse wasn't confident
	track?: string; // canonical title for a lyrics lookup; absent when the parse wasn't confident
	/** The full billing when the upload credited more than the primary. NOT a lookup key — it RANKS the records
	 *  a search returns, which is how a version with a guest verse is told from one without. */
	artistCredit?: string;
	album?: string;
	durationSec?: number; // narrows an LRCLIB match and bounds line-sync fallback timings
	/** The lyrics engines for an `align` job. Optional on the wire, so an older core still produces valid
	 *  params; the worker's own defaults are these same values. */
	asrModel?: string;
	syncMode?: string;
	/** A HUMAN re-pick: the candidate this `align` job must re-time instead of selecting. The worker
	 *  SHORT-CIRCUITS grading and re-times from the retained vocals stem. */
	pinnedRef?: string;
	/** PASTED lyrics no provider had; `pinnedRef` is the key it is written under, so the two travel together. */
	pinnedText?: string;
}

// core -> worker
export type WorkerCommand =
	| { type: 'worker:welcome'; heartbeatIntervalSec: number; ackTimeoutSec: number; mediaStore: MediaStoreConfig }
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
	| { type: 'ping' };

export interface JobArtifacts {
	/** MediaStore keys for the FILES separation published. `guideMix` belongs here BECAUSE it is a file, and is
	 *  a third entry rather than a replacement. Optional: there may be no vocals stem, or the encode failed. */
	stems?: { instrumental?: string; vocals?: string; guideMix?: string };
	/** What separation LEARNED about the music. A SIBLING of `stems`, never a member, and the NESTING is why it
	 *  is declared rather than read structurally. See docs/SERVER.md#what-the-worker-is-told. */
	songProfile?: SongProfile;
	/** What a `fetch` job identified this song AS; absent is the normal outcome. Applied under a never-regress
	 *  rule — see docs/SERVER.md#media-storage-and-paths. */
	annotation?: {
		source: string;
		mbid: string;
		artist: string;
		title: string;
		confidence: string;
	};
	/** `uri` is the single best artifact; `candidates` is the full set, one per TEXT SOURCE, which the core
	 *  ranks. */
	lyrics?: { uri: string; candidates?: LyricsCandidate[] };
	pitch?: { uri: string }; // reference pitch-track JSON
	/** What a `fetch` job retained as the ORIGINAL audio. Nothing reads it today, but EVERY key the worker
	 *  writes must be declared here. See docs/SERVER.md#what-the-worker-is-told. */
	source?: { audio: string };
}

export * from './ops';
export * from './types';
export type { Media };
