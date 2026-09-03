// Core domain types — shared by the Bun server (authoritative) and the SvelteKit client.
// See docs/ARCHITECTURE.md (Data model).

import type { LyricsCandidate } from './lyrics';

export type MediaSource = 'youtube' | 'local';
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
   * The canonical artist, normalized from the title and only set when the parse was
   * CONFIDENT — a low-confidence guess stays undefined rather than being displayed as fact. Prefer
   * this over `artist` for display and grouping; `artist` remains the raw provenance.
   */
  artistCanonical?: string;
  /**
   * The canonical TITLE, from the same normalizer and confidence rule as `artistCanonical`. `title`
   * stays the RAW title because that is what search matches and what a singer recognises in a result
   * list — but a lyrics lookup needs the song's actual name, so "Britney Spears - Baby One More Time
   * (Lyrics)" must resolve to "Baby One More Time" or LRCLIB misses on track_name. Undefined when the
   * parse wasn't confident.
   */
  titleCanonical?: string;
  durationSec: number;
  thumbnail?: string;
  stemStatus: StemStatus;
  /** MediaStore key of the separated instrumental (set when a stems job completes). This is what
   *  the TV file player loads; `sourceRef` stays the origin so the worker can still fetch the
   *  source and search can still recognise the song. */
  instrumentalRef?: string;
  /**
   * Which separator produced the CURRENT `instrumentalRef`. The upgrade path compares a candidate's
   * quality rank against this before swapping, so an upgrade can never replace a better instrumental
   * with a worse one. Absent on media cooked before separator selection existed, which
   * `isQualityUpgrade` treats as "anything ranked is an improvement".
   */
  separator?: { engine: string; model: string };
  lyricsRef?: string; // MediaStore key of the word-timed lyrics JSON artifact — drives the
  // TV karaoke overlay. Absent until an align job completes; the overlay no-ops without it.
  // This is the CHOSEN candidate (see lyricsCandidates + pickBestLyrics).
  /**
   * Every lyrics artifact this song has, one per text source. `lyricsRef` points at whichever
   * `pickBestLyrics` selected; the rest are kept so a better source arriving later can be re-aligned
   * from retained audio — and so a coarser late arrival can never displace existing word timings.
   *
   * The candidate matching `lyricsRef` is where the TV reads PROVENANCE from. Derive it with
   * `chosenCandidate(media)` rather than duplicating the fields here.
   */
  lyricsCandidates?: LyricsCandidate[];
  pitchRef?: string; // MediaStore key of the reference pitch-track JSON artifact — the
  // melody the server scores the live mic against. Absent until a score job completes.
}

/**
 * The MediaStore key the player should load, or `''` when this song has nothing playable yet.
 *
 * Nothing plays unprocessed: the only thing the TV ever loads is a separated instrumental. There is
 * no embed path and no raw-source path, so a song that has not been cooked is simply not playable —
 * which is what `isPlayable` reports and what rotation gates on.
 *
 * Keeping this in one pure helper is what lets `sourceRef` stay immutable: the player asks "what do I
 * load" instead of assuming the origin field was rewritten under it.
 */
export function playbackRef(m: Pick<Media, 'stemStatus' | 'instrumentalRef'>): string {
  return m.stemStatus === 'ready' && m.instrumentalRef ? m.instrumentalRef : '';
}

/**
 * Can this song be played at all? True only for a cooked song with an instrumental on disk.
 *
 * `stemStatus === 'ready'` alone is not enough: the status and the artifact key are written by
 * separate steps, and a status without a ref would hand the player an empty source.
 */
export function isPlayable(m: Pick<Media, 'stemStatus' | 'instrumentalRef'>): boolean {
  return playbackRef(m) !== '';
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
  keyShift: number; // semitones the current song is transposed (+sharp / -flat), 0 = original
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
 * renders these; the TV resolves `/media/${keyedMediaRef(sourceRef, n)}`. A ref with no file
 * extension is returned unchanged — keying only applies to a real artifact key.
 */
export function keyedMediaRef(sourceRef: string, keyShift: number): string {
  const k = clampKeyShift(keyShift);
  if (k === 0) return sourceRef;
  const dot = sourceRef.lastIndexOf('.');
  if (dot <= 0) return sourceRef; // no extension → not a keyable file ref
  const sign = k > 0 ? `+${k}` : `${k}`;
  return `${sourceRef.slice(0, dot)}.${sign}${sourceRef.slice(dot)}`;
}

export type JobType = 'stems' | 'align' | 'score' | 'stems-upgrade';
export type JobStatus = 'queued' | 'assigned' | 'running' | 'ready' | 'failed' | 'canceled';

// Terminal states never leave; the dedup index ignores them so a song can be re-processed after
// a failure/cancel. See docs/ARCHITECTURE.md.
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
  leaseExpiresAt: number | null; // epoch ms; ack-lease or progress-lease deadline
  createdAt: number;
  updatedAt: number;
}

/**
 * The lyrics candidate a media is currently showing — the one `lyricsRef` points at, and where the
 * TV reads provenance from. Returns null when the artifact predates candidate tracking: the honest
 * answer is "provenance unknown", not a fabricated one.
 *
 * Kept beside Media (like `playbackRef`) rather than in lyrics.ts so that module stays dependency-free.
 */
export function chosenCandidate(
  m: Pick<Media, 'lyricsRef' | 'lyricsCandidates'>
): LyricsCandidate | null {
  if (!m.lyricsRef || !m.lyricsCandidates?.length) return null;
  return m.lyricsCandidates.find((c) => c.ref === m.lyricsRef) ?? null;
}
