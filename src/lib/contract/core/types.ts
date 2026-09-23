// Core domain types — shared by the Bun server (authoritative) and the SvelteKit client.
// See docs/ARCHITECTURE.md (Data model).

import { pickBestLyrics, type LyricsCandidate } from '../lyrics/lyrics';
import type { SongProfile } from '../process/song-profile';
import type { TvBackgroundStyle } from '../presentation/tv-background';

/** Where a song's ORIGIN metadata came from. `youtube` and `local` are ACQUIRABLE; `spotify` is search and
 *  metadata ONLY, and `isProcessableSource` is the one authority that refuses it. See
 *  docs/SERVER.md#contract-boundary. */
export type MediaSource = 'youtube' | 'local' | 'spotify';
export type StemStatus = 'none' | 'queued' | 'ready';

/** Where one gated step of a process has got to. */
export type StepStatus = 'none' | 'queued' | 'ready';

export interface Media {
	id: string;
	source: MediaSource;
	/** The song's ORIGIN identity: youtube video id, or local file key. IMMUTABLE — see
	 *  docs/SERVER.md#media-storage-and-paths. */
	sourceRef: string;
	title: string;
	/** The UPLOADER as the source reported it (a YouTube channel, often not the artist at all). */
	artist?: string;
	/** The canonical artist, set only when the parse was CONFIDENT — a weak guess stays undefined rather than
	 *  displaying as fact. Prefer this over `artist` for display and grouping. */
	artistCanonical?: string;
	/** The FULL billing where `artistCanonical` holds only the primary; set only when they differ. Neither
	 *  display nor a lookup key — it RANKS provider records, which all match the primary artist. */
	artistCredit?: string;
	/** The canonical TITLE, same rule as `artistCanonical`. `title` stays RAW because search matches on it. */
	titleCanonical?: string;
	/** MusicBrainz recording id, set only when annotation agreed on artist AND title. Absent is normal. */
	mbid?: string;
	/** How the canonical fields came to be trusted. `musicbrainz` and `youtube` are CITATIONS, `normalizer` is
	 *  a parse, and the difference decides overwrite rights. See docs/SERVER.md#media-storage-and-paths. */
	annotation?: { source: 'musicbrainz' | 'youtube' | 'normalizer'; confidence: 'high' | 'medium' };
	durationSec: number;
	thumbnail?: string;
	/** Views the SOURCE last reported. Display and tie-breaking ONLY — never ranking, dedupe or any gate,
	 *  because a popularity number must not decide what plays. Optional, not 0, so a row omits the chip. */
	viewCount?: number;
	stemStatus: StemStatus;
	/** MediaStore key of the separated instrumental, set when a stems job completes. What the TV loads. */
	instrumentalRef?: string;
	/** Which separator produced the CURRENT `instrumentalRef`, so an upgrade can compare ranks and never
	 *  install a worse one. See docs/SERVER.md#registries-and-the-quality-ladder. */
	separator?: { engine: string; model: string };
	/** MediaStore key of the ISOLATED VOCALS stem. Present means the file existed AND carried audio — a
	 *  separation can succeed and write digital silence, and a ref set on trust advertises a guide that plays
	 *  nothing. */
	vocalsRef?: string;
	/** The GUIDE MIX: both stems in ONE 4-channel file, so the guide shares one playhead and cannot drift. A
	 *  SECOND ref and not a replacement; absent routes to the no-mix path. See docs/ARCHITECTURE.md §6. */
	guideMixRef?: string;
	/** MediaStore key of the word-timed lyrics artifact driving the TV overlay — the CHOSEN candidate.
	 *  Absent until an align job completes; the overlay no-ops without it. */
	lyricsRef?: string;
	/** Every lyrics artifact this song has, one per text source; the losers are KEPT. Read provenance via
	 *  `chosenCandidate(media)`. See docs/SERVER.md#lyrics-candidates-and-grading. */
	lyricsCandidates?: LyricsCandidate[];
	/** A HUMAN's explicit lyrics pick, by candidate `ref`. A SEPARATE field the resolver consults, never a
	 *  change to the ranking. See docs/SERVER.md#lyrics-candidates-and-grading. */
	lyricsOverrideRef?: string;
	/** The WORDS a human pasted for a `manual` re-pick. It lives on the MEDIA because a job row carries no
	 *  params, so a paste held anywhere narrower is lost by a restart between enqueue and dispatch. ALWAYS
	 *  paired with `lyricsOverrideRef`. See docs/SERVER.md#lyrics-candidates-and-grading. */
	lyricsOverrideText?: string;
	/** How far the `align` step has got. `ready` means alignment RAN, not that it found words. See
	 *  docs/SERVER.md#song-profile-and-readiness. */
	lyricsStatus?: StepStatus;
	/** What the process LEARNED about the music: key, range, loudness. Third artifact of the `stems` job, so
	 *  present means analysis RAN. See docs/SERVER.md#song-profile-and-readiness. */
	songProfile?: SongProfile;
}

/** The MediaStore key the player should load, or `''` when nothing is playable. Nothing plays unprocessed, and
 *  one pure helper is what lets `sourceRef` stay immutable. */
export function playbackRef(m: Pick<Media, 'stemStatus' | 'instrumentalRef'>): string {
	return m.stemStatus === 'ready' && m.instrumentalRef ? m.instrumentalRef : '';
}

/** Can this song be played at all? `stemStatus === 'ready'` alone is NOT enough — see
 *  docs/SERVER.md#song-profile-and-readiness. */
export function isPlayable(m: Pick<Media, 'stemStatus' | 'instrumentalRef'>): boolean {
	return playbackRef(m) !== '';
}

export interface Singer {
	id: string;
	displayName: string;
	color: string; // hex; the per-singer accent used across both surfaces
	sessionToken: string;
	joinedAt: number;
	/** When this singer last STARTED a song; absent/null = has not sung. See
	 *  docs/SERVER.md#queue-ordering-and-rotation. */
	lastSungAt?: number | null;
}

export type EntryStatus = 'queued' | 'playing' | 'done';

export interface QueueEntry {
	id: string; // client-minted ULID (zero-flicker reconcile — see docs/ARCHITECTURE.md §3)
	mediaId: string;
	singerId: string;
	status: EntryStatus;
	rotationSeq: number; // server-owned position in the stored ordered list
	addedAt: number;
}

export interface PlaybackState {
	currentEntryId: string | null;
	positionSec: number;
	isPlaying: boolean;
	keyShift: number; // semitones the current song is transposed (+sharp / -flat), 0 = original
	/** Per-song override of the room's TV background; `null` = defer to the room. EPHEMERAL, and the per-song
	 *  reset is a trap — see docs/SERVER.md#authority-and-the-hub. */
	background: TvBackgroundStyle | null;
	/** The GUIDING TRACK level for the current song, 0..1. `null` is NOT zero — it means inherit the room, and
	 *  is what this resets to per song. Resolve with `effectiveGuideLevel`, never raw. */
	guideLevel: number | null;
}

// A perfect fifth either way, which covers most voices.
export const MAX_KEY_SHIFT = 7;

/** Clamp a requested key shift to the supported ±MAX_KEY_SHIFT range (integer semitones). */
export function clampKeyShift(semitones: number): number {
	if (!Number.isFinite(semitones)) return 0;
	return Math.max(-MAX_KEY_SHIFT, Math.min(MAX_KEY_SHIFT, Math.trunc(semitones)));
}

// Transposition happens in the browser (`src/lib/tv/pitch-shift.ts`), so there is deliberately no
// pre-rendered pitch-shifted artifact and no ref helper that would resolve one.
export type JobType = 'fetch' | 'stems' | 'align' | 'stems-upgrade';
export type JobStatus = 'queued' | 'assigned' | 'running' | 'ready' | 'failed' | 'canceled';

/**
 * The wire vocabulary that CAUSES a job status change — the event, never the destination status, because a
 * status pair is event-lossy. See docs/SERVER.md#the-attempt-ledger.
 */
export const JOB_EVENTS = [
	'DISPATCH', // queued → assigned: offered to a worker
	'ACCEPT', // assigned → running: worker accepted, processing begins
	'PROGRESS', // running → running: heartbeat / stage update (the named self-loop)
	'REJECT', // assigned → queued: worker declined (no attempt burned)
	'LEASE_EXPIRED', // assigned|running → queued: ack-timeout or progress-lease expiry
	'COMPLETE', // running → ready: worker finished (terminal ✅)
	'FAIL', // queued|running → failed: attempts exhausted / non-retryable (terminal ❌)
	'CANCEL', // any non-terminal → canceled: song removed before finish (terminal)
	'RECOVER', // assigned|running → queued: boot recovery re-queues an interrupted attempt
	'REPRIORITIZE' // queued|assigned|running → same: lower scheduling priority, no status change
] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];

// Terminal states never leave. The `(mediaId, jobType)` dedup index ignores them, which is what lets a
// song be re-processed after a failure or a cancel.
export const TERMINAL_JOB_STATUSES = ['ready', 'failed', 'canceled'] as const;

export function isTerminalJob(status: JobStatus): boolean {
	return (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

export interface Job {
	id: string;
	mediaId: string;
	jobType: JobType;
	/** The PROCESS this job belongs to — one id shared by every step of one run. `mediaId` cannot group runs,
	 *  and a `stems-upgrade` starts a NEW one. See docs/SERVER.md#the-attempt-ledger. */
	processingId: string;
	/** The singer who REQUESTED this process, or `null` for an internal caller that imposes no per-singer
	 *  cap. The cap counts live process JOBS and never queue entries — see
	 *  docs/SERVER.md#idempotency-and-the-process-cap. */
	singerId: string | null;
	status: JobStatus;
	priority: number; // mirror of soonest rotationSeq; lower = sooner
	attempts: number;
	maxAttempts: number;
	workerId: string | null;
	stage: string | null;
	progressPct: number;
	etaSec: number | null;
	error: string | null; // last failure message; shown on the phone with the fallback offer
	leaseExpiresAt: number | null; // epoch ms; ack-lease or progress-lease deadline
	createdAt: number;
	updatedAt: number;
}

/** How one attempt at one job ended. `abandoned` = returned to the queue (reject / lease expiry). */
export const ATTEMPT_OUTCOMES = ['ready', 'failed', 'canceled', 'abandoned'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** ONE ATTEMPT at one job — the audit spine, APPEND-ONLY, and the only place processing time is recorded.
 *  See docs/SERVER.md#the-attempt-ledger. */
export interface JobAttempt {
	id: string;
	jobId: string;
	mediaId: string;
	processingId: string;
	jobType: JobType;
	/** 1-based. Attempt 2 exists only because attempt 1 was abandoned or failed retryably. */
	attempt: number;
	workerId: string | null;

	/**
	 * FOUR clocks; every reported duration is a subtraction between two of them, and each stays null until its
	 * moment happens. See docs/SERVER.md#the-attempt-ledger.
	 *
	 *   assignedAt − enqueuedAt → queue wait      startedAt − assignedAt → ack latency
	 *   finishedAt − startedAt  → processing time  finishedAt − enqueuedAt, by processingId → end-to-end
	 */
	enqueuedAt: number;
	assignedAt: number | null;
	startedAt: number | null;
	finishedAt: number | null;

	outcome: AttemptOutcome | null; // null = still in flight
	error: string | null;

	/** WHAT ACTUALLY RAN, and NOT re-derivable later. See docs/SERVER.md#the-attempt-ledger. */
	engine: string | null;
	model: string | null;
	backend: string | null;
	device: string | null;
	asrModel: string | null;
	syncMode: string | null;

	/** The song's length, SNAPSHOTTED so a later re-annotation cannot rewrite historical rates. */
	audioSec: number | null;

	/** Per-stage wall clock as a JSON string. Stored whole because it is only ever READ whole; read it with
	 *  `attemptStages()`. */
	stages: string | null;

	/** WHY the published lyric was chosen, as a JSON string; parse with `attemptSelection()`. Its home is the
	 *  audit trail and NOT the sidecar: a rejected candidate is run history, not library identity. */
	selection: string | null;
}

/** Parse an attempt's stage breakdown. Returns [] for absent or malformed JSON — a corrupt diagnostic
 *  must degrade to "no breakdown", never throw inside a dashboard render. */
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

/** WHY one lyric candidate won, as durable data, because a log is gone by the time someone notices wrong
 *  lyrics. Deliberately NOT the rejected lyric BODIES — label plus score says which arm fired. */
export interface SelectionRecord {
	/** True when no candidate existed and a baseline is being shown as the answer. */
	baselineFallback: boolean;
	/** True when the winner's BASELINE COVERAGE fell below the wrong-song threshold, so it is probably
	 *  a different song. Decided on coverage, not on `winnerScore` — see `isLikelyWrongSong`. */
	winnerSuspect: boolean;
	/** Composite RANKING score of the published winner, or null when nothing could judge it. This is
	 *  what ordered the candidates; it is NOT the axis `winnerSuspect` was decided on. */
	winnerScore: number | null;
	/**
	 * Baseline COVERAGE of the published winner — the number `winnerSuspect` was actually thresholded
	 * against. Null when nothing could judge it.
	 *
	 * OPTIONAL because an attempt row written before the coverage axis landed carries no such key, and
	 * `attemptSelection` parses defensively rather than rejecting an older record: a missing coverage must
	 * read as "not recorded", never as a decision made on nothing.
	 */
	winnerCoverage?: number | null;
	/** One entry per source that offered a choice among versions, in the order considered. */
	choices: VariantChoiceRecord[];
}

/** One source's pick among its own versions. `chosen`/`chosenScore` null when nothing could judge. */
export interface VariantChoiceRecord {
	textSource: string;
	considered: number;
	chosen: string | null;
	chosenScore: number | null;
	/** "agreement" when baselines decided it, "metadata" when they could not and cheap ranking stood. */
	decidedBy: string;
	/** How many baselines actually voted on the winner. 0 means the mean could not be formed. */
	votes: number;
	/** Every version not chosen, with its composite score (null if unjudgeable). */
	rejected: { label: string | null; score: number | null }[];
}

/** Parse an attempt's selection provenance. Returns null for absent or malformed JSON, so a corrupt
 *  diagnostic degrades to "no record" and never throws inside a dashboard render. */
export function attemptSelection(a: Pick<JobAttempt, 'selection'>): SelectionRecord | null {
	if (!a.selection) return null;
	try {
		const p = JSON.parse(a.selection);
		if (!p || typeof p !== 'object' || !Array.isArray(p.choices)) return null;
		// Every choice must carry a string `textSource`: the metrics page keys its `{#each}` on it, so an
		// element from a partial worker would key on undefined and THROW at render. Reject the whole record
		// rather than render half of one.
		if (
			!p.choices.every(
				(c: unknown) =>
					c !== null && typeof c === 'object' && typeof (c as { textSource?: unknown }).textSource === 'string'
			)
		) {
			return null;
		}
		return p as SelectionRecord;
	} catch {
		return null;
	}
}

/** Seconds of compute per second of audio for one attempt. Null when it never ran or has no length. */
export function realtimeFactor(a: Pick<JobAttempt, 'startedAt' | 'finishedAt' | 'audioSec'>): number | null {
	if (a.startedAt === null || a.finishedAt === null) return null;
	if (!a.audioSec || a.audioSec <= 0) return null;
	return (a.finishedAt - a.startedAt) / 1000 / a.audioSec;
}

/** The candidate a media is currently showing — where the TV reads provenance. Null when the artifact
 *  predates candidate tracking, because "unknown" is the honest answer. */
export function chosenCandidate(m: Pick<Media, 'lyricsRef' | 'lyricsCandidates'>): LyricsCandidate | null {
	if (!m.lyricsRef || !m.lyricsCandidates?.length) return null;
	return m.lyricsCandidates.find((c) => c.ref === m.lyricsRef) ?? null;
}

/** The single place that resolves WHICH candidate wins: a human override if one is set and still on disk,
 *  otherwise the ranking. BOTH rank-derivation sites must route through here. See
 *  docs/SERVER.md#lyrics-candidates-and-grading. */
export function resolveLyricsRef(
	candidates: readonly LyricsCandidate[] | undefined,
	overrideRef: string | null | undefined
): string | undefined {
	const set = candidates ?? [];
	if (overrideRef && set.some((c) => c.ref === overrideRef)) return overrideRef;
	return pickBestLyrics(set)?.ref;
}

/** Under a sticky override, would the RANKER now prefer a different candidate? Drives the phone's "a better
 *  version exists" hint. `false` with no override, on agreement, or when the pinned ref is gone. */
export function hasNewerCandidateThanOverride(
	candidates: readonly LyricsCandidate[] | undefined,
	overrideRef: string | null | undefined
): boolean {
	if (!overrideRef) return false;
	const set = candidates ?? [];
	if (!set.some((c) => c.ref === overrideRef)) return false;
	const ranked = pickBestLyrics(set)?.ref;
	return ranked !== undefined && ranked !== overrideRef;
}
