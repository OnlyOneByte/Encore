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
	/** Set only when the parse was CONFIDENT — a weak guess stays undefined rather than displaying as fact. */
	artistCanonical?: string;
	/** The FULL billing where `artistCanonical` holds only the primary. Neither display nor a lookup key —
	 *  it RANKS provider records, which all match the primary artist. */
	artistCredit?: string;
	/** The canonical TITLE, same rule as `artistCanonical`. `title` stays RAW because search matches on it. */
	titleCanonical?: string;
	/** MusicBrainz recording id, set only when annotation agreed on artist AND title. Absent is normal. */
	mbid?: string;
	/** `musicbrainz` and `youtube` are CITATIONS, `normalizer` is a parse, `manual` is the host's rename, which
	 *  nothing overwrites. The difference decides overwrite rights. See docs/SERVER.md#media-storage-and-paths. */
	annotation?: { source: 'musicbrainz' | 'youtube' | 'normalizer' | 'manual'; confidence: 'high' | 'medium' };
	durationSec: number;
	thumbnail?: string;
	/** Display and tie-breaking ONLY — never ranking, dedupe or any gate: a popularity number must not
	 *  decide what plays. Optional, not 0, so a row omits the chip. */
	viewCount?: number;
	stemStatus: StemStatus;
	/** The download a fetch job kept (`audio/<id>.<ext>`), which stems and align read instead of the watch URL.
	 *  Absent on a library file and on a song fetched before downloads were kept. */
	originalRef?: string;
	/** `originalRef`'s size at fetch, always set with it. */
	originalBytes?: number;
	/** What the TV loads. Set when a stems job completes. */
	instrumentalRef?: string;
	/** So an upgrade can compare ranks and never install a worse one.
	 *  See docs/SERVER.md#registries-and-the-quality-ladder. */
	separator?: { engine: string; model: string };
	/** Present means the file existed AND carried audio: a separation can succeed and write digital silence,
	 *  and a ref set on trust advertises a guide that plays nothing. */
	vocalsRef?: string;
	/** Both stems in ONE 4-channel file, so the guide shares one playhead and cannot drift. A SECOND ref, not
	 *  a replacement; absent routes to the no-mix path. */
	guideMixRef?: string;
	/** The CHOSEN candidate's artifact; the overlay no-ops without it. */
	lyricsRef?: string;
	/** One per text source; the losers are KEPT. See docs/SERVER.md#lyrics-candidates-and-grading. */
	lyricsCandidates?: LyricsCandidate[];
	/** A HUMAN's pick, by candidate `ref`. A SEPARATE field the resolver consults, never a ranking change. */
	lyricsOverrideRef?: string;
	/** On the MEDIA because a job row carries no params: a paste held anywhere narrower is lost by a restart
	 *  between enqueue and dispatch. ALWAYS paired with `lyricsOverrideRef`. */
	lyricsOverrideText?: string;
	/** Counts the host's lyrics changes; a save must name the current one. See docs/SERVER.md#lyrics-fixes. */
	lyricsEditRev?: number;
	/** The host's whole-song nudge, in ms: negative shows the words earlier. See docs/SERVER.md#lyrics-fixes. */
	lyricsOffsetMs?: number;
	/** `ready` means alignment RAN, not that it found words. */
	lyricsStatus?: StepStatus;
	/** Key, range, loudness. Third artifact of the `stems` job, so present means analysis RAN. */
	songProfile?: SongProfile;
}

/** GET /api/library/sizes, host only: what each ready song holds in the media store. See docs/SERVER.md#managing-the-library. */
export interface LibrarySizes {
	/** `remakeFailed` / `lyricsRemakeFailed`: why the song's last Make again (sound / lyrics) didn't work, while that
	 *  is still the latest. */
	songs: Record<
		string,
		{ bytes: number; plays: number; kept: boolean; remakeFailed?: string; lyricsRemakeFailed?: string }
	>;
	totalBytes: number;
	keptBytes: number;
	/** ENCORE_MEDIA_MAX_GB in bytes, or null when unset. */
	capBytes: number | null;
}

/** How long a library delete waits for Undo. */
export const DELETE_UNDO_MS = 10_000;

/** `''` when nothing is playable. One pure helper here is what lets `sourceRef` stay immutable. */
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
	/** The singer's key and guide, chosen BEFORE the turn (the on-deck card). The song start applies them in place
	 *  of the per-song reset; absent is the reset itself (0, and `null` = inherit the room). */
	keyShift?: number;
	guideLevel?: number | null;
	/** "Not yet" has been spent on this entry — it is allowed once. */
	deferred?: boolean;
	/** The TV could not play this turn's song. The entry is back to `queued` and HOLDS its slot: the rotation skips it
	 *  until the singer acts, so a machine failure costs nobody their place. Server-owned. */
	playFailed?: boolean;
	/** How many times the TV has failed THIS song in this turn. At two, Try again is refused and only Pick another is
	 *  offered: a dead file tried a third time helps nobody. A new song (`replace-media`) starts again at 0. Server-owned. */
	playFailures?: number;
}

export interface PlaybackState {
	currentEntryId: string | null;
	positionSec: number;
	isPlaying: boolean;
	keyShift: number; // semitones the current song is transposed (+sharp / -flat), 0 = original
	/** `null` = defer to the room. EPHEMERAL, and the per-song reset is a trap — see
	 *  docs/SERVER.md#authority-and-the-hub. */
	background: TvBackgroundStyle | null;
	/** 0..1. `null` is NOT zero — it means inherit the room, and is what this resets to per song. Resolve
	 *  with `effectiveGuideLevel`, never raw. */
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
/** `stems-remake` and `align-remake` are the host's Make it again (proposal 33 PR 3) for the sound and the
 *  lyrics: on a song that stays ready throughout, under new names, swapped in by their completion. */
export type JobType = 'fetch' | 'stems' | 'align' | 'stems-upgrade' | 'stems-remake' | 'align-remake';
export type JobStatus = 'queued' | 'assigned' | 'running' | 'ready' | 'failed' | 'canceled';

/** The event, never the destination status, because a status pair is event-lossy. See
 *  docs/SERVER.md#the-attempt-ledger. */
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
	/** One id shared by every step of one run. `mediaId` cannot group runs, and a `stems-upgrade` starts a
	 *  NEW one. See docs/SERVER.md#the-attempt-ledger. */
	processingId: string;
	/** `null` for an internal caller, which imposes no cap. See docs/SERVER.md#idempotency-and-the-process-cap. */
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

/** `abandoned` = returned to the queue (reject / lease expiry). */
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

	/** FOUR clocks, each null until its moment happens. Queue wait, ack latency and processing time are the
	 *  successive differences; end-to-end is finishedAt − enqueuedAt grouped by processingId. See
	 *  docs/SERVER.md#the-attempt-ledger. */
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
	/** torch's intra-op threads on the worker that ran it (`WorkerProfile.threads`). */
	threads: number | null;
	asrModel: string | null;
	syncMode: string | null;

	/** The song's length, SNAPSHOTTED so a later re-annotation cannot rewrite historical rates. */
	audioSec: number | null;

	/** Per-stage wall clock, stored whole because it is only ever READ whole; parse with `attemptStages()`. */
	stages: string | null;

	/** Parse with `attemptSelection()`. Belongs to the audit trail and NOT the sidecar: a rejected candidate
	 *  is run history, not library identity. */
	selection: string | null;

	/** The worker's own decision history — which text was tried, which knob was varied, why each attempt was
	 *  rejected. Stored whole because nothing queries inside it. This is the
	 *  answer to "why did this job publish THESE lyrics" weeks later, which no counter can give. */
	trail: string | null;

	/** Why an align job published no lyrics, when the worker knows (`LYRICS_NOTES`). Null otherwise. */
	lyricsNote: string | null;

	/** The assigned worker's jobs at once, demucs `-j` and whisper compute type (`WorkerProfile`), stamped
	 *  like `threads`. The warm-up is boot-only, so no attempt records it. */
	concurrency: number | null;
	demucsJobs: number | null;
	asrCompute: string | null;
	/** The profile settings set by hand, comma-joined `PROFILE_SETTINGS` names; '' means all were picked and
	 *  null that the worker did not say. Parse with `attemptHandSet()`. */
	handSet: string | null;
}

/** The hand-set profile names of an attempt, or null when its worker did not say. */
export function attemptHandSet(a: Pick<JobAttempt, 'handSet'>): string[] | null {
	return a.handSet == null ? null : a.handSet.split(',').filter(Boolean);
}

/** The reasons a worker may give for publishing no lyrics; anything else it sends is dropped. `asr-offline`: the
 *  worker is offline and its whisper checkpoint isn't cached, so it could not listen for words (#1221).
 *  `asr-babble`: whisper's transcript was not words, so the worker withheld it (#1288). */
export const LYRICS_NOTES = ['asr-offline', 'asr-babble'] as const;
export type LyricsNote = (typeof LYRICS_NOTES)[number];

/** [] for absent or malformed JSON: a corrupt diagnostic must never throw inside a dashboard render. */
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

/** Durable, because a log is gone by the time someone notices wrong lyrics. Deliberately NOT the rejected
 *  lyric BODIES — label plus score says which arm fired. */
export interface SelectionRecord {
	/** True when no candidate existed and a baseline is being shown as the answer. */
	baselineFallback: boolean;
	/** True when the winner's BASELINE COVERAGE fell below the wrong-song threshold, so it is probably
	 *  a different song. Decided on coverage, not on `winnerScore` — see `isLikelyWrongSong`. */
	winnerSuspect: boolean;
	/** Composite RANKING score of the published winner, or null when nothing could judge it. This is
	 *  what ordered the candidates; it is NOT the axis `winnerSuspect` was decided on. */
	winnerScore: number | null;
	/** Baseline COVERAGE of the published winner — the number `winnerSuspect` was actually thresholded
	 *  against. OPTIONAL because a row written before the coverage axis landed carries no such key, and a
	 *  missing coverage must read as "not recorded", never as a decision made on nothing. */
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

/** Null for absent or malformed JSON, so a corrupt diagnostic never throws inside a dashboard render. */
export function attemptSelection(a: Pick<JobAttempt, 'selection'>): SelectionRecord | null {
	if (!a.selection) return null;
	try {
		const p = JSON.parse(a.selection);
		if (!p || typeof p !== 'object' || !Array.isArray(p.choices)) return null;
		// `textSource` must be a string on EVERY choice: the metrics page keys its `{#each}` on it, so one
		// element from a partial worker keys on undefined and THROWS at render.
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

/** Where the TV reads provenance. Null when the artifact predates candidate tracking — "unknown" is the
 *  honest answer. */
export function chosenCandidate(m: Pick<Media, 'lyricsRef' | 'lyricsCandidates'>): LyricsCandidate | null {
	if (!m.lyricsRef || !m.lyricsCandidates?.length) return null;
	return m.lyricsCandidates.find((c) => c.ref === m.lyricsRef) ?? null;
}

/** A human override if one is set and still on disk, otherwise the ranking. BOTH rank-derivation sites
 *  MUST route through here. See docs/SERVER.md#lyrics-candidates-and-grading. */
export function resolveLyricsRef(
	candidates: readonly LyricsCandidate[] | undefined,
	overrideRef: string | null | undefined
): string | undefined {
	const set = candidates ?? [];
	if (overrideRef && set.some((c) => c.ref === overrideRef)) return overrideRef;
	// The host's own words are shown only while pinned, so "back to automatic" really leaves them.
	return pickBestLyrics(set.filter((c) => c.textSource !== 'manual'))?.ref;
}

/** Drives the phone's "a better version exists" hint. `false` with no override, on agreement, when the
 *  pinned ref is gone, or when the pin is the host's own words, which no ranking outdoes. */
export function hasNewerCandidateThanOverride(
	candidates: readonly LyricsCandidate[] | undefined,
	overrideRef: string | null | undefined
): boolean {
	if (!overrideRef) return false;
	const set = candidates ?? [];
	const pinned = set.find((c) => c.ref === overrideRef);
	if (!pinned || pinned.textSource === 'manual') return false;
	const ranked = resolveLyricsRef(set, undefined);
	return ranked !== undefined && ranked !== overrideRef;
}
