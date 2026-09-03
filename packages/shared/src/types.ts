// Core domain types — shared by the Bun server (authoritative) and the SvelteKit client.
// See docs/MASTER-DESIGN.md §5 (Data model).

import type { LyricsCandidate } from './lyrics';

export type MediaSource = 'youtube' | 'local';
export type PlayMode = 'iframe' | 'file';
export type StemStatus = 'none' | 'queued' | 'ready';

export interface Media {
  id: string;
  source: MediaSource;
  /**
   * The song's ORIGIN identity: youtube video id, or local file key. IMMUTABLE for the life of the
   * media — it is what search dedupes on (`source` + `sourceRef`), so overwriting it forks one song
   * into two rows: the cooked one in the library and a fresh uncooked one on the next search.
   * The separated instrumental lives in `instrumentalRef`, never here.
   */
  sourceRef: string;
  title: string;
  /** The UPLOADER as the source reported it (a YouTube channel, often not the artist at all). */
  artist?: string;
  /**
   * The canonical artist, normalized from the title (B-7-C1) and only set when the parse was
   * CONFIDENT — a low-confidence guess stays undefined rather than being displayed as fact. Prefer
   * this over `artist` for display and grouping; `artist` remains the raw provenance.
   */
  artistCanonical?: string;
  /**
   * The canonical TITLE, from the same normalizer and with the same confidence rule as
   * `artistCanonical` (B-3-C1). `title` stays the RAW title because that is what search matches and
   * what a singer recognises in a result list — but a lyrics lookup needs the song's actual name, so
   * "Britney Spears - Baby One More Time (Lyrics)" has to resolve to "Baby One More Time" or LRCLIB
   * misses on track_name even when the artist is right. Undefined when the parse wasn't confident.
   */
  titleCanonical?: string;
  durationSec: number;
  thumbnail?: string;
  stemStatus: StemStatus;
  playMode: PlayMode; // the abstraction flag that carries the whole future (iframe -> file)
  /** MediaStore key of the separated instrumental (set when a stems job completes). This is what
   *  the TV file player loads; `sourceRef` stays the origin so the worker can still fetch the
   *  source and search can still recognise the song. */
  instrumentalRef?: string;
  lyricsRef?: string; // MediaStore key of the word-timed lyrics JSON (M7-C8 artifact) — drives the
  // TV karaoke overlay (M8-C2). Absent until an align job completes; the overlay no-ops without it.
  // As of B-3-C5 this is the CHOSEN candidate (see lyricsCandidates + pickBestLyrics).
  /**
   * Every lyrics artifact this song has (B-3-C5), one per text source. `lyricsRef` points at whichever
   * `pickBestLyrics` selected; the rest are kept so a better source arriving later can be re-aligned
   * from the retained audio without re-downloading or re-separating anything — and so a coarser late
   * arrival can never displace existing word timings.
   *
   * The candidate matching `lyricsRef` is also where the TV reads PROVENANCE from, which is how the
   * overlay can be honest about auto-transcribed words. Derive it with `chosenCandidate(media)` rather
   * than duplicating the fields here.
   */
  lyricsCandidates?: LyricsCandidate[];
  pitchRef?: string; // MediaStore key of the reference pitch-track JSON (M8-C3 artifact) — the
  // melody the server scores the live mic against. Absent until a score job completes.
}

/**
 * The MediaStore key (file media) or embed id (iframe media) the player should load. A cooked song
 * plays its instrumental; everything else plays its origin. Keeping this in one pure helper is what
 * lets `sourceRef` stay immutable — the player asks for "what to play" instead of assuming the
 * origin field was rewritten under it.
 */
export function playbackRef(m: Pick<Media, 'sourceRef' | 'playMode' | 'instrumentalRef'>): string {
  return m.playMode === 'file' && m.instrumentalRef ? m.instrumentalRef : m.sourceRef;
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

/**
 * The lyrics candidate a media is currently showing — i.e. the one `lyricsRef` points at (B-3-C5).
 *
 * This is where the TV reads provenance from, so it can label auto-transcribed words instead of
 * presenting a guess as the song's real lyrics. Returns null when the artifact predates candidate
 * tracking: the honest answer is "provenance unknown", not a fabricated one.
 *
 * Kept beside Media (like `playbackRef`) rather than in lyrics.ts so that module stays dependency-free.
 */
export function chosenCandidate(
  m: Pick<Media, 'lyricsRef' | 'lyricsCandidates'>
): LyricsCandidate | null {
  if (!m.lyricsRef || !m.lyricsCandidates?.length) return null;
  return m.lyricsCandidates.find((c) => c.ref === m.lyricsRef) ?? null;
}
