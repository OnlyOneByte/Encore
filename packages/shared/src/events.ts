// WebSocket event vocabulary — the wire contract between core, phones, TV, and workers.
// See docs/ARCHITECTURE.md.

import type { Media, QueueEntry, Singer, PlaybackState, JobType } from './types';
import type { ServerPatch, ClientCommand } from './ops';
import type { LyricsCandidate } from './lyrics';
import type { EffectiveSettings, TvBackgroundStyle } from './separators';

export const ROOM_TOPIC = 'room:main'; // single room for MVP; Bun.serve pub/sub topic

export type MediaStatus =
  | 'queued'
  | 'downloading'
  | 'separating'
  | 'aligning'
  | 'ready'
  | 'failed';

// A singer safe to broadcast (no sessionToken).
export type PublicSinger = Omit<Singer, 'sessionToken'>;

// ── core -> all clients (broadcasts) ───────────────────────────────────────
export type ServerEvent =
  | { type: 'queue:patch'; patch: ServerPatch }
  // singers/media are optional directories so clients can render names/titles per entry.
  // `online` is the presence snapshot (singer ids with a live socket) — a client that connects
  // mid-party needs the roster immediately, not on the next presence change.
  | { type: 'queue:sync'; rev: number; entries: QueueEntry[]; singers?: PublicSinger[]; media?: Media[]; online?: string[]; settings?: EffectiveSettings }
  | { type: 'playback:state'; state: PlaybackState; rev: number }
  | { type: 'nowplaying:changed'; current: QueueEntry | null; upNext: QueueEntry | null }
  | { type: 'media:status'; mediaId: string; status: MediaStatus; pct: number; etaSec?: number }
  // Live SingStar-style score for the current song, recomputed as mic pitch arrives.
  // `score` is a 0..100 rolling accuracy; hits/total are the scored (voiced-reference) frames.
  | { type: 'score:update'; entryId: string; singerId: string; score: number; hits: number; total: number }
  | { type: 'singer:joined'; singer: Singer }
  // Who is in the room RIGHT NOW — the full set of singer ids holding a live socket,
  // broadcast whenever it changes. Full-set (not a delta) on purpose: it is a handful of ids, and
  // an idempotent snapshot cannot drift the way an add/remove stream can after a dropped frame.
  | { type: 'singer:presence'; online: string[] }
  // Room-level separator settings changed. Full snapshot, not a delta (same reasoning as presence).
  | { type: 'settings:changed'; settings: EffectiveSettings }
  | { type: 'op:reject'; clientOpId: string; reason: string };

// ── phone/TV -> core ────────────────────────────────────────────────────────
export type PlayerCommand =
  | { cmd: 'play' }
  | { cmd: 'pause' }
  | { cmd: 'skip' }
  | { cmd: 'restart' }
  | { cmd: 'seek'; positionSec: number }
  // ± key on a make-karaoke (file) song. `semitones` is the ABSOLUTE target (not a delta), clamped
  // server-side to ±MAX_KEY_SHIFT; the server picks the matching pre-rendered instrumental.
  | { cmd: 'key'; semitones: number }
  // Per-song override of the room's TV background. `style: null` hands the song back to the room
  // default. Whitelisted server-side against TV_BACKGROUND_STYLES — never trusted as a string.
  | { cmd: 'background'; style: TvBackgroundStyle | null };

export type ClientEvent =
  | { type: 'queue:command'; command: ClientCommand }
  | { type: 'player:command'; command: PlayerCommand }
  | { type: 'tv:telemetry'; positionSec: number; durationSec: number; status: string; bufferedNextPct: number }
  // Phone → core: one live mic pitch sample. f0Hz=0 means the phone detected no pitch
  // (silence). The core scores it against the current song's reference pitch track at positionSec.
  | { type: 'mic:pitch'; positionSec: number; f0Hz: number; confidence?: number }
  | { type: 'hello'; lastRev: number };

// ── dial-home worker protocol ─────────────────────────────────────────────────
// Workers connect TO the core over WS (NAT-friendly, scale-out). All messages are JSON
// { type, ...payload }. See docs/ARCHITECTURE.md.

// worker -> core
export type WorkerMessage =
  | { type: 'worker:hello'; workerId: string; authToken?: string; capabilities: string[]; concurrency: number; version: string; host?: WorkerHost }
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
    }
  | { type: 'job:failed'; workerId: string; jobId: string; error: string; retryable: boolean };

/**
 * What the worker actually ran, as opposed to what the core asked for.
 *
 * These differ more often than it looks: a processor applies its own default when the core sends no
 * model, resolves a token to a checkpoint (a token was once found to resolve to a DIFFERENT model
 * than the one benchmarked under that name), and falls back to CPU when a requested backend will not
 * load. The core cannot know any of it, so per-model metrics built from dispatched values would be
 * reporting requests as facts. Every field optional: a step reports only the axes that apply to it.
 */
export interface ResolvedFacts {
  engine?: string;
  model?: string;
  backend?: string;
  device?: string;
  asrModel?: string;
  syncMode?: string;
}

/**
 * How long one stage of a job took. The core can already derive TOTAL processing time from its own
 * accept→complete stamps; this is the SPLIT it cannot see — whether the 43 minutes were the download
 * or the separation. Measured on the worker because only it observes a stage transition.
 */
export interface StageTiming {
  stage: string;
  ms: number;
}

/** The box a worker runs on. Best-effort and every field optional — a diagnostic must never fail a
 *  handshake, and torch is genuinely absent under ENCORE_PROCESSOR=stub. */
export interface WorkerHost {
  platform?: string;
  machine?: string;
  python?: string;
  cpuCount?: number;
  torch?: string;
  cuda?: boolean;
}

// Where workers pull source / push stems. local = a shared volume (single-box); object = S3/MinIO
// for workers on other boxes (MASTER-DESIGN §2). Sent verbatim in worker:welcome.
export type MediaStoreConfig =
  | { kind: 'local' }
  | { kind: 'object'; bucket: string; endpoint?: string; region?: string; prefix?: string };

/**
 * Per-job inputs the core derives and the worker consumes. One flat optional bag rather than a union
 * per JobType, because a worker reads only the keys its processor needs and an unknown key must never
 * break an older worker.
 *
 * `artist`/`track` are the CONFIDENCE-GATED canonicals, not the raw uploader and title: an align job
 * that looked up "7clouds — Britney Spears - Baby One More Time (Lyrics)" misses on metadata alone.
 * Before this existed the contract was `{ model?, targetKey? }` and worker-hub sent only `{ model }`,
 * so `WhisperXProcessor` hard-raised on every align job.
 *
 * `language` is deliberately ABSENT: nothing populates it, and sending a guessed 'en' is worse than
 * letting the worker default and the ASR pass detect it.
 */
export interface JobParams {
  /**
   * How the worker should obtain `sourceUri` — DECLARED, never inferred from the URI's shape.
   * `ytdlp` means download it; `local` means it is already a path under the media volume. Set on every
   * job that touches source audio, so a worker never has to guess (see packages/shared/src/fetchers.ts).
   */
  fetcher?: string;
  model?: string; // separation model/checkpoint token (stems) — resolved by the worker engine
  engine?: string; // separation engine id (stems): 'demucs' | 'roformer' | 'ensemble'
  targetKey?: string; // requested key shift, if a job ever pre-renders one
  artist?: string; // canonical artist for a lyrics lookup; absent when the parse wasn't confident
  track?: string; // canonical title for a lyrics lookup; absent when the parse wasn't confident
  album?: string;
  durationSec?: number; // narrows an LRCLIB match and bounds line-sync fallback timings
  /**
   * The lyrics engines for an `align` job, chosen by the deployment (see lyrics-engines.ts).
   * `asrModel` is a faster-whisper token; `syncMode` is 'forced' (wav2vec2 word timings) or 'lines'
   * (use each source's own line timings and skip the align model entirely).
   *
   * Optional on the wire so a core that predates the setting still produces valid params — the worker
   * falls back to its own defaults, which are these same values.
   */
  asrModel?: string;
  syncMode?: string;
}

// core -> worker
export type WorkerCommand =
  | { type: 'worker:welcome'; heartbeatIntervalSec: number; ackTimeoutSec: number; mediaStore: MediaStoreConfig }
  | { type: 'job:assign'; jobId: string; mediaId: string; jobType: JobType; sourceUri: string; params: JobParams }
  | { type: 'job:cancel'; jobId: string; reason: string }
  | { type: 'ping' };

export interface JobArtifacts {
  stems?: { instrumental?: string; vocals?: string };
  /**
   * What a `fetch` job identified this song AS, when MusicBrainz agreed. Absent when annotation was
   * declined — which is the normal outcome for anything the normalizer could not name confidently, a
   * weak duration match, or an unreachable service. The core applies it under a never-regress rule so
   * a later `medium` cannot overwrite an earlier `high`.
   */
  annotation?: {
    source: string;
    mbid: string;
    artist: string;
    title: string;
    confidence: string;
  };
  /**
   * `uri` is the single best artifact (the original single-artifact shape, still what
   * `setMediaLyrics` reads).
   * `candidates` is the full set an align job produced — one entry per TEXT SOURCE, each its own file.
   * The core ranks them with `pickBestLyrics`; the worker's `uri` is only a convenience
   * pointer so a completed job is useful before the core stores the candidate set.
   */
  lyrics?: { uri: string; candidates?: LyricsCandidate[] };
  pitch?: { uri: string }; // reference pitch-track JSON — drives server-side mic scoring
}

export * from './ops';
export * from './types';
export type { Media };
