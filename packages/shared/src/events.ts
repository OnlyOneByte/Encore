// WebSocket event vocabulary — the wire contract between core, phones, TV, and workers.
// See docs/MASTER-DESIGN.md §3 and docs/job-lifecycle-and-worker-protocol.md §5.

import type { Media, QueueEntry, Singer, PlaybackState, JobType } from './types';
import type { ServerPatch, ClientCommand } from './ops';

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
  | { type: 'queue:sync'; rev: number; entries: QueueEntry[]; singers?: PublicSinger[]; media?: Media[]; online?: string[] }
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
// { type, ...payload }. See docs/job-lifecycle-and-worker-protocol.md §5.

// worker -> core
export type WorkerMessage =
  | { type: 'worker:hello'; workerId: string; authToken?: string; capabilities: JobType[]; concurrency: number; version: string }
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

// core -> worker
export type WorkerCommand =
  | { type: 'worker:welcome'; heartbeatIntervalSec: number; ackTimeoutSec: number; mediaStore: MediaStoreConfig }
  | { type: 'job:assign'; jobId: string; mediaId: string; jobType: JobType; sourceUri: string; params: { model?: string; targetKey?: string } }
  | { type: 'job:cancel'; jobId: string; reason: string }
  | { type: 'ping' };

export interface JobArtifacts {
  stems?: { instrumental?: string; vocals?: string };
  lyrics?: { uri: string };
  pitch?: { uri: string }; // reference pitch-track JSON (M8-C3) — drives server-side mic scoring
}

// re-export the op layer so consumers import everything from one place
export * from './ops';
export * from './types';
export type { Media };
