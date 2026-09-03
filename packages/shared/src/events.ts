// WebSocket event vocabulary — the wire contract between core, phones, TV, and workers.
// See docs/ARCHITECTURE.md.

import type { Media, QueueEntry, Singer, PlaybackState, JobType } from './types';
import type { ServerPatch, ClientCommand } from './ops';
import type { LyricsCandidate } from './lyrics';
import type { RoomSettings } from './separators';

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
  // mid-party needs the roster immediately, not on the next presence change (B-6-C1).
  | { type: 'queue:sync'; rev: number; entries: QueueEntry[]; singers?: PublicSinger[]; media?: Media[]; online?: string[]; settings?: RoomSettings }
  | { type: 'playback:state'; state: PlaybackState; rev: number }
  | { type: 'nowplaying:changed'; current: QueueEntry | null; upNext: QueueEntry | null }
  | { type: 'media:status'; mediaId: string; status: MediaStatus; pct: number; etaSec?: number }
  // Live SingStar-style score for the current song (M8-C3), recomputed as mic pitch arrives.
  // `score` is a 0..100 rolling accuracy; hits/total are the scored (voiced-reference) frames.
  | { type: 'score:update'; entryId: string; singerId: string; score: number; hits: number; total: number }
  | { type: 'singer:joined'; singer: Singer }
  // Who is in the room RIGHT NOW (B-6-C1) — the full set of singer ids holding a live socket,
  // broadcast whenever it changes. Full-set (not a delta) on purpose: it is a handful of ids, and
  // an idempotent snapshot cannot drift the way an add/remove stream can after a dropped frame.
  | { type: 'singer:presence'; online: string[] }
  // Room-level separator settings changed (B-8). Full snapshot, not a delta — a handful of fields,
  // and an idempotent snapshot cannot drift after a dropped frame (same reasoning as presence).
  | { type: 'settings:changed'; settings: RoomSettings }
  | { type: 'op:reject'; clientOpId: string; reason: string };

// ── phone/TV -> core ────────────────────────────────────────────────────────
export type PlayerCommand =
  | { cmd: 'play' }
  | { cmd: 'pause' }
  | { cmd: 'skip' }
  | { cmd: 'restart' }
  | { cmd: 'seek'; positionSec: number }
  // ± key on a make-karaoke (file) song. `semitones` is the ABSOLUTE target (not a delta), clamped
  // server-side to ±MAX_KEY_SHIFT; the server picks the matching pre-rendered instrumental (M7-C9).
  | { cmd: 'key'; semitones: number };

export type ClientEvent =
  | { type: 'queue:command'; command: ClientCommand }
  | { type: 'player:command'; command: PlayerCommand }
  | { type: 'tv:telemetry'; positionSec: number; durationSec: number; status: string; bufferedNextPct: number }
  // Phone → core: one live mic pitch sample (M8-C3). f0Hz=0 means the phone detected no pitch
  // (silence). The core scores it against the current song's reference pitch track at positionSec.
  | { type: 'mic:pitch'; positionSec: number; f0Hz: number; confidence?: number }
  | { type: 'hello'; lastRev: number };

// ── dial-home worker protocol ─────────────────────────────────────────────────
// Workers connect TO the core over WS (NAT-friendly, scale-out). All messages are JSON
// { type, ...payload }. See docs/ARCHITECTURE.md.

// worker -> core
export type WorkerMessage =
  | { type: 'worker:hello'; workerId: string; authToken?: string; capabilities: string[]; concurrency: number; version: string }
  | { type: 'worker:heartbeat'; workerId: string; slotsFree: number; runningJobIds: string[] }
  | { type: 'job:accept'; workerId: string; jobId: string }
  | { type: 'job:reject'; workerId: string; jobId: string; reason: string }
  | { type: 'job:progress'; workerId: string; jobId: string; stage: MediaStatus; pct: number; etaSec?: number }
  | { type: 'job:complete'; workerId: string; jobId: string; mediaUri: string; artifacts?: JobArtifacts }
  | { type: 'job:failed'; workerId: string; jobId: string; error: string; retryable: boolean };

// Where workers pull source / push stems. local = a shared volume (single-box); object = S3/MinIO
// for workers on other boxes (MASTER-DESIGN §2). Sent verbatim in worker:welcome (M7-C10).
export type MediaStoreConfig =
  | { kind: 'local' }
  | { kind: 'object'; bucket: string; endpoint?: string; region?: string; prefix?: string };

/**
 * Per-job inputs the core derives and the worker consumes (B-3-C1). One flat optional bag rather
 * than a union per JobType, because a worker reads only the keys its processor needs and an unknown
 * key must never break an older worker.
 *
 * `artist`/`track` are the CONFIDENCE-GATED canonicals, not the raw uploader and raw title: an align
 * job that looked up "7clouds — Britney Spears - Baby One More Time (Lyrics)" misses on metadata
 * alone. Before this existed the contract was `{ model?, targetKey? }` and worker-hub sent only
 * `{ model }`, so `WhisperXProcessor` hard-raised on every align job it was ever given.
 *
 * `language` is deliberately ABSENT for now: nothing populates it (the sidecar field is unset), and
 * sending a guessed 'en' is worse than letting the worker default and B-3-C4's ASR detect it.
 */
export interface JobParams {
  model?: string; // separation model/checkpoint token (stems) — resolved by the worker engine (B-8)
  engine?: string; // separation engine id (stems): 'demucs' | 'roformer' | 'ensemble' (B-8)
  targetKey?: string; // requested key shift, if a job ever pre-renders one
  artist?: string; // canonical artist for a lyrics lookup; absent when the parse wasn't confident
  track?: string; // canonical title for a lyrics lookup; absent when the parse wasn't confident
  album?: string;
  durationSec?: number; // narrows an LRCLIB match and bounds line-sync fallback timings
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
   * `uri` is the single best artifact (the pre-B-3 shape, still what `setMediaLyrics` reads).
   * `candidates` is the full set an align job produced — one entry per TEXT SOURCE, each its own file
   * (B-3-C3). The core ranks them with `pickBestLyrics`; the worker's `uri` is only a convenience
   * pointer so a completed job is useful before B-3-C5 stores the set.
   */
  lyrics?: { uri: string; candidates?: LyricsCandidate[] };
  pitch?: { uri: string }; // reference pitch-track JSON (M8-C3) — drives server-side mic scoring
}

// re-export the op layer so consumers import everything from one place
export * from './ops';
export * from './types';
export type { Media };
