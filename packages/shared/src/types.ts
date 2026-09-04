// Core domain types — shared by the Bun server (authoritative) and the SvelteKit client.
// See docs/ARCHITECTURE.md (Data model).

import type { LyricsCandidate } from './lyrics';
import type { TvBackgroundStyle } from './separators';

export type MediaSource = 'youtube' | 'local';
export type StemStatus = 'none' | 'queued' | 'ready';

/**
 * Where one processing step of the cook has got to. Same shape as `StemStatus`, named for the general
 * case because the cook now has more than one gated step (see gates.ts).
 */
export type StepStatus = 'none' | 'queued' | 'ready';

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
  /**
   * MusicBrainz recording id, when a `fetch` job's annotation agreed on artist AND title and the
   * duration corroborated it. Absent when annotation was declined — which is the normal outcome for a
   * song the normalizer could not name, a weak duration match, or an unreachable service.
   */
  mbid?: string;
  /**
   * How `artistCanonical`/`titleCanonical` came to be trusted. `musicbrainz` means a citation with an
   * MBID; `normalizer` means a title parse and nothing more. Kept because the two are not equal
   * evidence and the difference decides whether a later annotation may overwrite them.
   */
  annotation?: { source: 'musicbrainz' | 'normalizer'; confidence: 'high' | 'medium' };
  durationSec: number;
  thumbnail?: string;
  /**
   * Views the SOURCE reported, at the moment we last saw this song in a search.
   *
   * Display only, and a TIEBREAKER rather than a fact about the song: between two lyric uploads of one
   * track, 2.1B vs 266K is what tells a singer which is the canonical one. Deliberately not used by
   * ranking, dedupe or any gate — a popularity number must never decide what plays.
   *
   * Undefined means "never learned one" (a local library file, or a resolver that reports none), which
   * is why it is optional rather than 0: the row omits the chip instead of claiming zero views.
   */
  viewCount?: number;
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
  /**
   * MediaStore key of the ISOLATED VOCALS stem — the guiding track. Separation always produces it
   * alongside the instrumental, so this is a keep-not-compute field.
   *
   * Present means the file existed AND carried audio when the job completed. Both halves matter: a
   * separation can succeed and still write digital silence, and a ref set on trust alone advertises
   * a guiding track that plays nothing (see `apps/core/src/server/media/loudness.ts`). Absent → the
   * phone control is unavailable and the TV renders no second element, which is the honest
   * degradation rather than a broken mix.
   */
  vocalsRef?: string;
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
  /**
   * How far the `align` step has got — the lyrics half of the cook gate (see gates.ts).
   *
   * `ready` means alignment RAN, not that it found words: a genuine instrumental completes with no
   * `lyricsRef`, and it is still a finished song. Absent on media cooked before this field existed,
   * which the gate treats as done when a lyrics artifact is already present.
   */
  lyricsStatus?: StepStatus;
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

/**
 * Can this song offer a guiding track (the original vocals mixed back under the instrumental)?
 *
 * Requires BOTH a playable instrumental and a vocals stem, because the guide is an overlay on
 * something — there is nothing to mix vocals under until the song is playable at all. Songs
 * separated before the ref was persisted, and songs whose vocals stem came back silent, report
 * false and simply do not offer the control.
 */
export function hasGuidingTrack(
  m: Pick<Media, 'stemStatus' | 'instrumentalRef' | 'vocalsRef'>
): boolean {
  return isPlayable(m) && !!m.vocalsRef;
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
  /**
   * Per-song override of the room's TV background. `null` = defer to the room default, which is the
   * normal state — the TV resolves `playback.background ?? room.tvBackgroundStyle`.
   *
   * An OVERRIDE rather than a show/hide toggle, because that subsumes the toggle ('off' is the hide
   * case) and additionally buys "make it purple, just for this song" with no extra mechanism.
   *
   * Ephemeral like keyShift: reset to null on every song change. Note that this reset is EXPLICIT at
   * each site in realtime/player.ts — nothing rebuilds this object per song — so a field omitted
   * there silently leaks into the next singer's turn.
   */
  background: TvBackgroundStyle | null;
  /**
   * The GUIDING TRACK level for the current song: how loud the isolated original vocals sit under
   * the instrumental, 0 = pure karaoke … 1 = full sing-along.
   *
   * `null` is not zero — it means "no per-song override, use the room default"
   * (`RoomSettings.guideLevelDefault`). That distinction is the whole point of the field: `keyShift`
   * resets to 0 on every song, and copying that here would make a singer who wants a faint guide
   * re-drag the slider for every single song. So this resets to `null` (inherit) on song change,
   * and only a deliberate touch of the control pins a number to this one song.
   *
   * Resolve it with `effectiveGuideLevel` rather than reading it raw — a raw read cannot tell
   * "inherit" from "explicitly off".
   */
  guideLevel: number | null;
}

// How far the singer can transpose, in semitones (a perfect fifth either way — covers most voices).
export const MAX_KEY_SHIFT = 7;

/** Clamp a requested key shift to the supported ±MAX_KEY_SHIFT range (integer semitones). */
export function clampKeyShift(semitones: number): number {
  if (!Number.isFinite(semitones)) return 0;
  return Math.max(-MAX_KEY_SHIFT, Math.min(MAX_KEY_SHIFT, Math.trunc(semitones)));
}

/**
 * Clamp a requested guiding-track level to `[0,1]`, or `null` to CLEAR the per-song override.
 *
 * `null`/`undefined` pass through as `null` (inherit the room default) — this is a settable field
 * where "cleared" and "rejected" must not collapse into the same value, so garbage is also `null`
 * rather than a silent 0: refusing to invent a level is honest, and inheriting is the safe fallback.
 * Rounded to whole percent so the persisted value stays tidy and two drags that land on the same
 * notch compare equal.
 */
export function clampGuideLevel(level: number | null | undefined): number | null {
  if (level === null || level === undefined || !Number.isFinite(level)) return null;
  return Math.round(Math.max(0, Math.min(1, level)) * 100) / 100;
}

/**
 * The level the TV should actually mix at: the per-song override when one is pinned, otherwise the
 * room default. Never returns null — the player needs a number for `.volume`.
 */
export function effectiveGuideLevel(
  playback: Pick<PlaybackState, 'guideLevel'>,
  roomDefault: number
): number {
  return playback.guideLevel ?? clampGuideLevel(roomDefault) ?? 0;
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

export type JobType = 'fetch' | 'stems' | 'align' | 'score' | 'stems-upgrade';
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
  /**
   * The COOK this job belongs to — one id shared by every step of one run (fetch → stems → align).
   *
   * `mediaId` cannot do this job. A song can be cooked more than once: a failure frees the dedup slot
   * so it can be re-cooked, and `stems-upgrade` re-separates a finished song. Grouping attempt
   * records by `mediaId` alone therefore blends distinct runs together, which makes an end-to-end
   * duration meaningless (it would span from the first cook's enqueue to the last upgrade's finish).
   * A `stems-upgrade` deliberately starts a NEW cook rather than inheriting: it is background work on
   * an already-finished song, and its cost belongs to itself.
   */
  cookId: string;
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

/** How one attempt at one job ended. `abandoned` = returned to the queue (reject / lease expiry). */
export const ATTEMPT_OUTCOMES = ['ready', 'failed', 'canceled', 'abandoned'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/**
 * ONE ATTEMPT at one job — the audit spine, and the only place processing time is recorded.
 *
 * WHY THIS TABLE EXISTS. The `jobs` row is mutated in place: it carries `createdAt` and `updatedAt`
 * and nothing else, and `updatedAt` is overwritten by every progress frame. So a finished job says
 * only "this changed most recently at T" — you cannot tell how long it WAITED from how long it RAN,
 * you cannot see a previous attempt at all (`attempts` is a counter and `error` keeps only the last
 * message), and you cannot tell which model produced the result. None of that is recoverable later:
 * an unrecorded duration is gone permanently. This table records each attempt as its own row.
 *
 * WHAT "APPEND-ONLY" MEANS HERE, PRECISELY. A row is opened when the job enters the queue and is
 * filled in as that ONE attempt progresses (assigned → started → finished). Once it reaches an
 * outcome it is never written again, and a retry opens a NEW row rather than overwriting the old one.
 * So history is immutable; only the attempt currently in flight is still being written.
 */
export interface JobAttempt {
  id: string;
  jobId: string;
  mediaId: string;
  cookId: string;
  jobType: JobType;
  /** 1-based. Attempt 2 exists only because attempt 1 was abandoned or failed retryably. */
  attempt: number;
  workerId: string | null;

  /**
   * FOUR clocks, because one cannot answer the question. Every duration the dashboards report is a
   * subtraction between two of these, and each is null until that moment actually happens — a job
   * that never got picked up has no `startedAt`, and saying 0 there would invent work that never ran.
   *
   *   assignedAt − enqueuedAt  → queue wait (was the fleet busy?)
   *   startedAt  − assignedAt  → ack latency (did the worker pick it up promptly?)
   *   finishedAt − startedAt   → PROCESSING TIME — the number the internal dashboard is for
   *   finishedAt − enqueuedAt, grouped by cookId → end-to-end for the whole song
   */
  enqueuedAt: number;
  assignedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;

  outcome: AttemptOutcome | null; // null = still in flight
  error: string | null;

  /**
   * WHAT ACTUALLY RAN. Recorded per attempt because these are resolved from GLOBAL SETTINGS at
   * dispatch time and settings are operator-editable: re-deriving a past cook's model from today's
   * settings gives a confidently wrong answer. Written at assign time from the dispatched params
   * (what was asked for); a worker that reports its own resolution overwrites them with the truth,
   * since a worker can legitimately resolve something different from what it was asked.
   */
  engine: string | null;
  model: string | null;
  backend: string | null;
  device: string | null;
  asrModel: string | null;
  syncMode: string | null;

  /**
   * The song's length, snapshotted. Raw seconds do not compare across songs — a 30s clip and a 7min
   * track are not the same workload — so every reported cost is a RATE (seconds of compute per
   * second of audio). Copied onto the attempt rather than joined from `media` because a media row's
   * duration can be re-annotated later, which would silently rewrite historical rates.
   */
  audioSec: number | null;

  /**
   * Per-stage wall clock as a JSON string: `[{"stage":"separating","ms":51000}]`. Stored whole rather
   * than as rows because it is only ever read whole — to render one attempt's breakdown — so a table
   * would add a join and a migration without enabling a query. Use `attemptStages()` to read it.
   */
  stages: string | null;
}

/** Parse an attempt's stage breakdown. Returns [] for absent or malformed JSON — a corrupt
 *  diagnostic must degrade to "no breakdown", never throw inside a dashboard render. */
export function attemptStages(a: Pick<JobAttempt, 'stages'>): { stage: string; ms: number }[] {
  if (!a.stages) return [];
  try {
    const parsed = JSON.parse(a.stages);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => typeof s?.stage === 'string' && Number.isFinite(s?.ms));
  } catch {
    return [];
  }
}

/** Seconds of compute per second of audio for one attempt. Null when it never ran or has no length. */
export function realtimeFactor(a: Pick<JobAttempt, 'startedAt' | 'finishedAt' | 'audioSec'>): number | null {
  if (a.startedAt === null || a.finishedAt === null) return null;
  if (!a.audioSec || a.audioSec <= 0) return null;
  return (a.finishedAt - a.startedAt) / 1000 / a.audioSec;
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
