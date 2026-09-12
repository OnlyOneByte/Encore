// Core domain types — shared by the Bun server (authoritative) and the SvelteKit client.
// See docs/ARCHITECTURE.md (Data model).

import { pickBestLyrics, type LyricsCandidate } from '../lyrics/lyrics';
import type { SongProfile } from '../cook/song-profile';
import type { TvBackgroundStyle } from '../presentation/tv-background';

/**
 * Where a song ORIGIN metadata came from.
 *
 * `youtube` and `local` are also ACQUIRABLE - a fetcher knows how to pull their bytes (see
 * fetchers.ts). `spotify` is a SEARCH / metadata source ONLY: Spotify gives clean canonical
 * artist/title/duration where a YouTube upload title has to be reverse-engineered, but its bytes
 * are never fetched from Spotify. The audio is still acquired from YouTube (the annotator pattern,
 * docs/DECISIONS.md), so a spotify-sourced media is not cookable - `isCookableSource` in fetchers.ts
 * is the one authority that says so, and every layer that decides whether a cook is possible asks it.
 * (`fetcherFor` does NOT refuse a spotify source; it returns the default downloader as a floor.)
 * This needs no DB migration (the column is plain text, no CHECK) and no fetch:spotify capability.
 */
export type MediaSource = 'youtube' | 'local' | 'spotify';
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
	 * The FULL artist billing as the upload wrote it ("Lady Gaga feat. Beyoncé"), where
	 * `artistCanonical` is only the primary. Set only when it differs from the primary — i.e. when the
	 * upload actually credited more than one artist.
	 *
	 * Not for display, and not a lookup key. It rides on an `align` job so the worker can tell two
	 * RECORDINGS of a song apart: a lyrics provider holds a record per version and every one of them
	 * matches the primary artist, so a song with a guest verse otherwise gets whichever record the
	 * provider happens to return. See `rank_lrclib_candidates` in the worker.
	 */
	artistCredit?: string;
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
	 * MBID; `youtube` means YouTube's OWN extracted `track`/`artist` metadata, captured at download time
	 * (a citation, `high`, no MBID — the uploader declared the credit rather than us guessing it);
	 * `normalizer` means a title parse and nothing more. Kept because the three are not equal evidence
	 * and the difference decides whether a later annotation may overwrite them (see applyAnnotation's
	 * never-regress rule). `youtube` and `musicbrainz` are both citations and neither may be downgraded
	 * to a `normalizer` guess.
	 */
	annotation?: { source: 'musicbrainz' | 'youtube' | 'normalizer'; confidence: 'high' | 'medium' };
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
	 * a guiding track that plays nothing (see `src/lib/server/media/loudness.ts`). Absent → the
	 * phone control is unavailable and the TV renders no second element, which is the honest
	 * degradation rather than a broken mix.
	 */
	vocalsRef?: string;
	/**
	 * Signed millisecond offset of the guiding track against the instrumental, MEASURED at cook time —
	 * the guide-alignment half of the guide feature made observable instead of assumed.
	 *
	 * `guide-sync.ts` is blind by construction to any offset baked into the DECODED audio: it only ever
	 * compares the two elements' reported `currentTime`, so a stem that is time-shifted in its samples
	 * (container priming, an mp4 edit list, a genuinely misaligned separation) leaves both playheads in
	 * agreement while the ears hear the guide early or late, and the governor holds for the whole song.
	 * This field carries what the ear would hear: the worker cross-correlates the two raw stems once and
	 * records how far the vocals sit from the instrumental. Positive = the guide LAGS the instrumental
	 * (its content arrives late, so it must be seeked EARLIER to line up); negative = it leads.
	 *
	 * `TvPlayer` adds it wherever it aligns the guide — the pre-roll lock-on, the jump path, and as the
	 * ZERO POINT `guideCorrection` measures drift against — so the offset arrives as an INPUT and
	 * `guide-sync.ts` stays a pure policy function with no new branch (read `guideOffsetSec` there).
	 *
	 * ABSENT OR 0 IS TODAY'S BEHAVIOUR, EXACTLY. Every song cooked before this field existed carries no
	 * value, and a freshly-cooked song whose two stems are the same FLAC codec decodes to a
	 * sample-exact common start and measures ~0 — so the field is 0 for essentially the whole library on
	 * the day it lands, and `guideOffsetSec` maps absent → 0. The non-zero case is a legacy `.m4a`
	 * vocals stem from before both stems became FLAC (the ~21 ms AAC priming asymmetry) or a
	 * deliberately shifted stem.
	 */
	guideOffsetMs?: number;
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
	 * A HUMAN'S explicit lyrics pick, by candidate `ref` — the fallback for when the ranker chose
	 * wrong. When set and still present in `lyricsCandidates`, it OUTRANKS `pickBestLyrics`
	 * everywhere the chosen candidate is resolved (`chosenLyricsRef` on restore, `setMediaLyrics` on a
	 * later align completion). `undefined` means no override — the ranking decides, as before.
	 *
	 * This is the one thing that can make the shown candidate WORSE by rank, so it is a SEPARATE field
	 * the resolver consults, never a change to `pickBestLyrics`: the never-regress guarantee
	 * (`mergeLyricsCandidate`) stays intact, and a later re-cook that produces a better candidate is
	 * still KEPT beside the pick — which is what lets the phone say "a better version exists" (
	 * owner ruling Q2=C: sticky, plus surface the newer candidate) instead of silently losing it.
	 */
	lyricsOverrideRef?: string;
	/**
	 * How far the `align` step has got — the lyrics half of the cook gate (see gates.ts).
	 *
	 * `ready` means alignment RAN, not that it found words: a genuine instrumental completes with no
	 * `lyricsRef`, and it is still a finished song. Absent on media cooked before this field existed,
	 * which the gate treats as done when a lyrics artifact is already present.
	 */
	lyricsStatus?: StepStatus;
	/**
	 * What the cook LEARNED about the music: detected key, and the range the original singer sang.
	 *
	 * Produced by the same `stems` job as the two audio stems, so it is the third artifact of one step
	 * rather than a separate pipeline stage — and it is the reason the `stems` gate checks for it (see
	 * gates.ts). Present means analysis RAN; the fields inside are individually nullable because a song
	 * can legitimately have no detectable key, no voiced vocal, or neither.
	 *
	 * Absent means not analysed yet, which for a song cooked before this field existed is also true —
	 * and is why the gate's predicate tolerates it via `stemStatus`, rather than making an existing
	 * library unsingable on upgrade.
	 */
	songProfile?: SongProfile;
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
 * The guide-alignment offset in SECONDS, ready to add to the master playhead — 0 whenever there is
 * nothing measured.
 *
 * The wire and the schema carry `guideOffsetMs` (a signed integer, or absent). The client aligns in
 * seconds, so this converts once and, crucially, DEFAULTS ABSENT/NON-FINITE TO 0: a song cooked before
 * the field existed, or one whose measurement was declined, is held exactly as today. Keeping the
 * default here — not at each call site — is what lets `guide-sync.ts` receive `masterSec + guideOffsetSec`
 * without ever branching on whether an offset was measured.
 */
export function guideOffsetSec(m: Pick<Media, 'guideOffsetMs'>): number {
	const ms = m.guideOffsetMs;
	return typeof ms === 'number' && Number.isFinite(ms) ? ms / 1000 : 0;
}

export interface Singer {
	id: string;
	displayName: string;
	color: string; // hex; the per-singer accent used across both surfaces
	sessionToken: string;
	joinedAt: number;
	/**
	 * When this singer last STARTED a song. Absent/null = has not sung.
	 *
	 * The signal the `least-recently-sung` ordering runs on, and the reason it lives on the singer
	 * rather than in the play log: `plays` deliberately carries no singer id, because over a small
	 * library "who sang what" is identifying. This records THAT someone sang and when — not what they
	 * sang — which is the least the rotation can know and still be fair, and it is why the stamp is
	 * safe to broadcast on the public roster the phones already receive.
	 *
	 * Stamped at song START, not end: the point is that their remaining picks drop behind everyone
	 * else's the moment their turn begins.
	 */
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
 * There is deliberately NO `keyedMediaRef` here any more.
 *
 * It used to resolve a pre-rendered pitch-shifted variant (`stems/<id>-instrumental.+2.flac`) that
 * nothing ever produced — `worker/src/pitch.py` existed as tested pure logic that `processor.py`
 * never called — so the TV had to ignore `keyShift` entirely or hand the gapless controller a 404
 * mid-song. Transposition now happens in the browser (see `src/lib/tv/pitch-shift.ts`),
 * which needs no files, works on every already-cooked song, and can shift the guiding-track stem by
 * the same amount instead of muting it. Both the ref helper and the worker renderer are gone.
 */
export type JobType = 'fetch' | 'stems' | 'align' | 'stems-upgrade';
export type JobStatus = 'queued' | 'assigned' | 'running' | 'ready' | 'failed' | 'canceled';

/**
 * The wire vocabulary that CAUSES a job status change — the event, not the destination status.
 *
 * A status pair is event-lossy: `assigned → queued` is both a worker REJECT and an ack-timeout
 * LEASE_EXPIRED, and `running → queued` is both a progress-lease expiry and boot RECOVER — the
 * machine could not tell them apart, so the ledger had to hook seven hand-written wrappers instead
 * of the machine itself (see attempts.ts). Keying transitions on the event restores the distinction
 * and lets `REPRIORITIZE` (a status-free scheduling write) be a legal internal edge rather than an
 * escape hatch outside the machine (repository.ts). Drawn from the §5 wire protocol.
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
	/**
	 * The singer who REQUESTED this cook, or `null` for internal callers that impose no per-singer
	 * cap (lyrics backfill, chained follow-up steps that inherit their parent's attribution). This is
	 * the authoritative attribution for the per-singer concurrent-cook cap: the cap counts a singer's
	 * live cook JOBS, not their queue entries, because the entry (WebSocket) and the cook (HTTP) ride
	 * different transports and only the entry is droppable — a phone that taps Sing while its socket is
	 * reconnecting files the cook with no entry to count, and an entry-derived cap admits every tap.
	 */
	singerId: string | null;
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

	/**
	 * WHY the published lyric was chosen, as a JSON string. Present only on `align` attempts
	 * that made a pick among versions; null everywhere else. Stored whole for the same reason as
	 * `stages` and `media.lyricsCandidates`: it is read whole to explain one attempt, never queried
	 * inside, so a table would buy a join and a migration for no query. Parse with `attemptSelection()`.
	 * The audit trail, not the sidecar, is its home: a rejected candidate is run history, not the
	 * library identity the sidecar projects into the media row.
	 */
	selection: string | null;
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

/**
 * WHY one lyric candidate won over the others, as durable data.
 *
 * The worker's `VariantChoice.summary()` already renders exactly these facts, but only to the cook
 * log, which rotates and is per-container and is long gone by the time someone notices wrong lyrics on
 * the TV weeks later. This is that same explanation crossed to the `/metrics/<mediaId>` audit trail so
 * a mis-pick is answerable from persisted state. Deliberately NOT the rejected lyric BODIES: label +
 * composite score is enough to say which arm fired (a metadata fallback no baseline could judge versus
 * a real disagreement the metric ranked), and four full rejected texts per song would multiply the
 * lyrics footprint for triage-only data.
 */
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
	 * OPTIONAL because an attempt row written before the coverage axis landed has no such key, and `attemptSelection`
	 * parses defensively rather than rejecting an older record: a missing coverage must read as "this
	 * worker did not record it", never as a decision made on nothing.
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
 *  diagnostic degrades to "no record" and never throws inside a dashboard render (mirrors attemptStages). */
export function attemptSelection(a: Pick<JobAttempt, 'selection'>): SelectionRecord | null {
	if (!a.selection) return null;
	try {
		const p = JSON.parse(a.selection);
		if (!p || typeof p !== 'object' || !Array.isArray(p.choices)) return null;
		// Every choice must carry a string textSource: the metrics page keys its {#each} on it, so an
		// element from an older/partial worker missing the field would key on undefined and THROW at
		// render — the exact outcome this guard exists to prevent. Reject the whole record rather than
		// render a half one.
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

/**
 * The lyrics candidate a media is currently showing — the one `lyricsRef` points at, and where the
 * TV reads provenance from. Returns null when the artifact predates candidate tracking: the honest
 * answer is "provenance unknown", not a fabricated one.
 *
 * Kept beside Media (like `playbackRef`) rather than in lyrics.ts so that module stays dependency-free.
 */
export function chosenCandidate(m: Pick<Media, 'lyricsRef' | 'lyricsCandidates'>): LyricsCandidate | null {
	if (!m.lyricsRef || !m.lyricsCandidates?.length) return null;
	return m.lyricsCandidates.find((c) => c.ref === m.lyricsRef) ?? null;
}

/**
 * The single place that resolves WHICH candidate wins: a human override if one is set and still on
 * disk, otherwise `pickBestLyrics`. Returns the winning `ref`, or `undefined` when nothing is
 * showable.
 *
 * Both rank-derivation sites route through here so override-then-rank has ONE definition:
 * `chosenLyricsRef` (sidecar restore, which re-ranks on every boot) and `setMediaLyrics` (which
 * re-ranks on every align completion). An override that names a `ref` no longer in the set is IGNORED,
 * not honoured blindly — a stale pointer must fall back to the ranking rather than blank the overlay.
 *
 * It does NOT touch `pickBestLyrics`: the override is layered ABOVE the ranking, so never-regress
 * (`mergeLyricsCandidate`) is untouched and a later better candidate is still kept for the
 * "newer version exists" affordance (`hasNewerCandidateThanOverride`).
 */
export function resolveLyricsRef(
	candidates: readonly LyricsCandidate[] | undefined,
	overrideRef: string | null | undefined
): string | undefined {
	const set = candidates ?? [];
	if (overrideRef && set.some((c) => c.ref === overrideRef)) return overrideRef;
	return pickBestLyrics(set)?.ref;
}

/**
 * Under a sticky human override (Q2=C), would the RANKER now prefer a different candidate — i.e. has a
 * later re-cook produced something the ranking rates above the pinned pick? Drives the phone's "a
 * better version exists" hint. `false` when there is no override, when the ranker agrees with the pick,
 * or when the pinned ref is no longer present (a stale override is not "beaten", it is gone).
 */
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
