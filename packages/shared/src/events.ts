// WebSocket event vocabulary — the wire contract between core, phones, TV, and workers.
// See docs/MASTER-DESIGN.md §3 and docs/job-lifecycle-and-worker-protocol.md §5.

import type { Media, QueueEntry, Singer, PlaybackState } from './types';
import type { ServerPatch, ClientCommand } from './ops';

export const ROOM_TOPIC = 'room:main'; // single room for MVP; Bun.serve pub/sub topic

export type MediaStatus =
  | 'queued'
  | 'downloading'
  | 'separating'
  | 'aligning'
  | 'ready'
  | 'failed';

// ── core -> all clients (broadcasts) ───────────────────────────────────────
export type ServerEvent =
  | { type: 'queue:patch'; patch: ServerPatch }
  | { type: 'queue:sync'; rev: number; entries: QueueEntry[] }
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
  | { cmd: 'seek'; positionSec: number };

export type ClientEvent =
  | { type: 'queue:command'; command: ClientCommand }
  | { type: 'player:command'; command: PlayerCommand }
  | { type: 'tv:telemetry'; positionSec: number; durationSec: number; status: string; bufferedNextPct: number }
  | { type: 'hello'; lastRev: number };

// re-export the op layer so consumers import everything from one place
export * from './ops';
export * from './types';
export type { Media };
