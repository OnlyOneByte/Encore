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
  keyShift: number; // semitones the current song is transposed (+sharp / -flat), 0 = original (M7-C9)
}

// How far the singer can transpose, in semitones (a perfect fifth either way — covers most voices).
export const MAX_KEY_SHIFT = 7;

/** Clamp a requested key shift to the supported ±MAX_KEY_SHIFT range (integer semitones). */
export function clampKeyShift(semitones: number): number {
  if (!Number.isFinite(semitones)) return 0;
  return Math.max(-MAX_KEY_SHIFT, Math.min(MAX_KEY_SHIFT, Math.trunc(semitones)));
}

/**
 * The MediaStore key for a file media at a given key shift. 0 → the original instrumental;
 * ±N → the pre-rendered pitch-shifted variant (e.g. `stems/m1-instrumental.+2.wav`). The worker
 * renders these (M7-C9); the TV resolves `/media/${keyedMediaRef(sourceRef, n)}`. A non-`.wav`/.mp4
 * ref (e.g. a youtube iframe ref) is returned unchanged — keying only applies to file media.
 */
export function keyedMediaRef(sourceRef: string, keyShift: number): string {
  const k = clampKeyShift(keyShift);
  if (k === 0) return sourceRef;
  const dot = sourceRef.lastIndexOf('.');
  if (dot <= 0) return sourceRef; // no extension → not a keyable file ref
  const sign = k > 0 ? `+${k}` : `${k}`;
  return `${sourceRef.slice(0, dot)}.${sign}${sourceRef.slice(dot)}`;
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
  error: string | null; // last failure message; shown on the phone with the fallback offer (§8)
  leaseExpiresAt: number | null; // epoch ms; ack-lease or progress-lease deadline (M7-C2)
  createdAt: number;
  updatedAt: number;
}
