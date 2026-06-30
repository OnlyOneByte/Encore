// Core domain types — shared by the Bun server (authoritative) and the SvelteKit client.
// See docs/MASTER-DESIGN.md §5 (Data model).

export type MediaSource = 'youtube' | 'local';
export type PlayMode = 'iframe' | 'file';
export type StemStatus = 'none' | 'queued' | 'ready';

export interface Media {
  id: string;
  source: MediaSource;
  sourceRef: string; // youtube id, or local file key
  title: string;
  artist?: string;
  durationSec: number;
  thumbnail?: string;
  stemStatus: StemStatus;
  playMode: PlayMode; // the abstraction flag that carries the whole future (iframe -> file)
}

export interface Singer {
  id: string;
  displayName: string;
  color: string; // hex; the per-singer accent used across both surfaces
  sessionToken: string;
  joinedAt: number;
}

export type EntryStatus = 'queued' | 'playing' | 'waiting' | 'done' | 'skipped';

export interface QueueEntry {
  id: string; // client-minted ULID (zero-flicker reconcile — see reconciliation-contract.md)
  mediaId: string;
  singerId: string;
  status: EntryStatus;
  rotationSeq: number; // server-owned fairness position (round-robin)
  addedAt: number;
}

export interface PlaybackState {
  currentEntryId: string | null;
  positionSec: number;
  isPlaying: boolean;
}

export type JobType = 'stems' | 'align' | 'score';
export type JobStatus = 'queued' | 'assigned' | 'running' | 'ready' | 'failed' | 'canceled';

// Terminal states never leave; the dedup index ignores them so a song can be re-processed after
// a failure/cancel. See docs/job-lifecycle-and-worker-protocol.md §2.
export const TERMINAL_JOB_STATUSES = ['ready', 'failed', 'canceled'] as const;

export function isTerminalJob(status: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

export interface Job {
  id: string;
  mediaId: string;
  jobType: JobType;
  status: JobStatus;
  priority: number; // mirror of soonest rotationSeq; lower = sooner
  attempts: number;
  maxAttempts: number;
  workerId: string | null;
  stage: string | null;
  progressPct: number;
  etaSec: number | null;
  leaseExpiresAt: number | null; // epoch ms; ack-lease or progress-lease deadline (M7-C2)
  createdAt: number;
  updatedAt: number;
}
