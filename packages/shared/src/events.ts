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
  // singers/media are optional directories so clients can render names/titles per entry
  | { type: 'queue:sync'; rev: number; entries: QueueEntry[]; singers?: PublicSinger[]; media?: Media[] }
  | { type: 'playback:state'; state: PlaybackState; rev: number }
  | { type: 'nowplaying:changed'; current: QueueEntry | null; upNext: QueueEntry | null }
  | { type: 'media:status'; mediaId: string; status: MediaStatus; pct: number; etaSec?: number }
  | { type: 'singer:joined'; singer: Singer }
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
}

// re-export the op layer so consumers import everything from one place
export * from './ops';
export * from './types';
export type { Media };
