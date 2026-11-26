// The I/O side of the dial-home protocol: WorkerRegistry + dispatch.ts + JobRepository + lease policy.
// Decoupled from Bun.serve via the `toWorker`/`broadcast` sinks, so it unit-tests with no socket.
// See docs/ARCHITECTURE.md §7.

import type {
	WorkerMessage,
	WorkerCommand,
	ServerEvent,
	MediaStatus,
	Media,
	Job,
	JobType,
	MediaStoreConfig,
	GlobalSettings,
	EffectiveSettings,
	WorkerProfile
} from '../../contract';
import { publishStemFormat, toRelativeKey, stemOutputTag, stemTagOf, lyricsTagOf } from '../media/paths';
import { queueSidecarTask } from '../media/sidecar';
import {
	ASR_COMPUTE_TYPES,
	LYRICS_NOTES,
	PROFILE_SETTINGS,
	resolveProcessSeparator,
	isTerminalJob,
	WORKER_STAGES
} from '../../contract';
import { OUTSTANDING_CHAIN, type JobRepository } from './repository';
import { readinessOf } from '../media/readiness';
import type { AttemptFacts, AttemptLedger } from './attempts';
import { WorkerRegistry, type WorkerSession } from './registry';
import {
	planAssignments,
	assignParams,
	assignSourceUri,
	followUps,
	requiredCapability,
	separatorFor,
	publishesInstrumental,
	reSeparates,
	waitsForTurn,
	inTurn,
	inheritsProcess,
	hasCapableWorker,
	type CapabilityFor
} from './dispatch';
import {
	markMediaReady,
	setMediaLyrics,
	remakeMediaLyrics,
	setMediaOriginal,
	setMediaVocals,
	setMediaGuideMix,
	setMediaSongProfile,
	applyAnnotation,
	settleLyricsGate,
	reportTerminalFailure,
	markLyricsQueued,
	type TerminalFailureDeps
} from './process';
import { cleanJobWork } from '../media/migrate-layout';
import { ackDeadline, progressDeadline, attemptsExhausted, DEFAULT_LEASE_CONFIG, type LeaseConfig } from './leases';
import { completedStatusFor, mediaStatusFor, shouldBroadcastProcess } from './media-status';
import { ETA_SAMPLE, ETA_WINDOW, etaSec, laterSteps, overrunAfterSec, sameEngine, workPerAudioSec } from './eta';

/** The stem files a song names now. */
function stemRefsOf(m: Media | undefined): string[] {
	return [m?.instrumentalRef, m?.vocalsRef, m?.guideMixRef].filter((r): r is string => !!r);
}

/** The stem files a completion says it wrote, as store refs. */
function reportedStemRefs(msg: Extract<WorkerMessage, { type: 'job:complete' }>): string[] {
	const s = msg.artifacts?.stems;
	return [s?.instrumental, s?.vocals, s?.guideMix].map((u) => toRelativeKey(u)).filter((r): r is string => !!r);
}

const STEMS_DIR = 'derived/stems/';
const LYRICS_DIR = 'derived/lyrics/';

/** The reported refs that are job `jobId`'s own output: in `derived/stems/`, named `<mediaId>-<its tag>-…`. The only
 *  worker-named files core deletes, so a worker cannot point it at another song's files. */
function ownStemOutput(
	refs: string[],
	jobId: string,
	mediaId?: string,
	[dir, tagOf] = [STEMS_DIR, stemTagOf]
): { mediaId: string; ref: string }[] {
	const tag = stemOutputTag(jobId);
	return refs.flatMap((ref) => {
		const name = ref.startsWith(dir) ? ref.slice(dir.length) : '';
		const owner = name.slice(0, Math.max(0, name.indexOf(`-${tag}-`)));
		if (!owner || (mediaId && owner !== mediaId) || tagOf(owner, name) !== tag) return [];
		return [{ mediaId: owner, ref }];
	});
}

/** A completion's lyrics documents, as store refs. */
function reportedLyricsRefs(msg: Extract<WorkerMessage, { type: 'job:complete' }>): string[] {
	const l = msg.artifacts?.lyrics;
	return [l?.uri, ...(l?.candidates ?? []).map((c) => c.ref)]
		.map((u) => toRelativeKey(u))
		.filter((r): r is string => !!r);
}

export type ToWorker = (workerId: string, cmd: WorkerCommand) => void;
export type Broadcast = (event: ServerEvent) => void;

/** Ceiling on continuous unservability before terminal `failed`; without it the job parks `queued`
 *  forever. Two minutes rides out a worker restart or a fleet coming up, without hanging a job that is
 *  genuinely unservable. `ENCORE_UNSERVABLE_TTL_MS` shortens it for a probe that films what follows it (the
 *  ui:review row of a Try again after the TTL), which would otherwise wait two minutes per run. */
const UNSERVABLE_TTL_MS = positiveMs(process.env.ENCORE_UNSERVABLE_TTL_MS) ?? 120_000;

/** A positive whole number of milliseconds, or undefined: a 0 or negative TTL would fail every job on first sight. */
export function positiveMs(raw: string | undefined): number | undefined {
	const n = Math.floor(Number(raw));
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** How long the fleet may lack a maker before the room is told it cannot make karaoke, counted from the loss or from
 *  boot. A worker redials 0.5, 1, 2 s apart, then every 3 s, ±50 % jitter (`transport/client.py` BACKOFF_SEC), so it
 *  is back within 4.5 s of core listening, inside this grace for a blip and for a core restart. */
export const MAKER_GRACE_MS = 10_000;

/** The steps EVERY song needs before it can be sung (both gates in `contract/queue/gates.ts`). Not `fetch`: a library
 *  upload needs none, so a fleet without a fetcher still makes those; a search result it cannot fetch is told per turn,
 *  by `unservable`, as before. */
const MAKES_KARAOKE: readonly JobType[] = ['stems', 'align'];

/** The two room verdicts `queue:sync` carries, each a boolean with its own grace clock. */
type MakerVerdict = 'canMake' | 'canFetch';

/** How the TTL's failure names its cause in `jobs.error`, read back by /api/library so a client that loads after
 *  the failure still says "no maker" rather than "that song didn't work". */
export const UNSERVABLE_ERROR_PREFIX = 'no connected worker advertised capability';

/**
 * THE ONE ANSWER to "which waiting songs died for want of a maker that is still missing?", shared by /api/library (a
 * client that loads now) and the hub's re-tell (clients already listening), so the two cannot drift.
 *
 * A song counts when it waits in a QUEUED turn, nothing of it is made yet, and its last chain job died at the TTL. It
 * stays "no maker" while ANY step from the one that died to the end of the chain has no connected worker: a worker
 * that only fetches does not make the song singable, so it must not clear the verdict.
 */
export function noMakerMedia(
	entries: readonly { status: string; mediaId: string }[],
	deps: { mediaById: Map<string, Media>; jobs: Pick<JobRepository, 'lastChainJob'>; settings?: GlobalSettings },
	offered: ReadonlySet<string>
): string[] {
	return [...new Set(entries.filter((e) => e.status === 'queued').map((e) => e.mediaId))].filter((id) => {
		const m = deps.mediaById.get(id);
		if (!m || readinessOf(m) !== 'unacquired') return false;
		const last = deps.jobs.lastChainJob(id);
		if (last?.status !== 'failed' || !last.error?.startsWith(UNSERVABLE_ERROR_PREFIX)) return false;
		return OUTSTANDING_CHAIN.slice(OUTSTANDING_CHAIN.indexOf(last.jobType)).some(
			(step) => !offered.has(requiredCapability(step, deps.settings))
		);
	});
}

export interface WorkerHubDeps {
	jobs: JobRepository;
	/** Per-attempt history. Optional so the hub still unit-tests bare; app.ts wires it. */
	attempts?: AttemptLedger;
	registry: WorkerRegistry;
	mediaById: Map<string, Media>;
	/** Deletes the guide-mix FILE when a completion carries no mix. Without it the stale-but-valid mix
	 *  survives and the next boot's backfill re-adopts it, pinning the room to superseded stems. */
	discardGuideMix?: (mediaId: string) => void | Promise<void>;
	/** `'silent'` REFUSES the completion; `'unknown'` still PUBLISHES — an unmeasurable file (no ffmpeg
	 *  on the host) is not silence, and refusing on it would be a self-inflicted outage. */
	verifyInstrumental?: (ref: string) => Promise<'audible' | 'silent' | 'unknown'>;
	toWorker: ToWorker; // send a WorkerCommand to ONE worker session
	broadcast: Broadcast; // media:status to the whole room
	/** Fired AFTER a media flips ready, so a held song plays at its fair slot if the room idled. */
	onMediaReady?: (mediaId: string) => void;
	/** Optional so the hub unit-tests with no DB; app.ts wires it to MediaRepository.upsert. */
	persistMedia?: (mediaId: string) => void;
	/** EFFECTIVE, not just global: the room's downward-only quality ceiling must reach both the engine a
	 *  stems job is dispatched with AND the capability it is routed by. */
	getSettings?: () => EffectiveSettings;
	now: () => number;
	config?: LeaseConfig;
	mediaStore?: MediaStoreConfig;
	/** The room's queue, read when what the fleet offers changes: whose "no maker" that change just flipped. REQUIRED,
	 *  so a construction that forgets it fails typecheck: nothing else would notice, the re-tell would just go quiet. */
	queueEntries: () => readonly { id?: string; status: string; mediaId: string }[];
	/** The playing entry, so a re-separation waits until the song's turn is over (`waitsForTurn`). */
	currentEntryId?: () => string | null;
	/** Deletes stem files a re-separation replaced, or wrote and lost, once no screen needs them (`settle`). Optional
	 *  so the hub unit-tests bare. */
	deleteRefs?: (refs: string[]) => void;
	/** Fired when `canMake()` or `canFetch()` flips, so app.ts can re-send the room its `queue:sync`. */
	onMakerChange?: () => void;
}

/** Validates an inbound frame BEFORE anything reads a field off it. This family carries DISPATCH
 *  AUTHORITY and is reachable UNAUTHENTICATED whenever core has no worker token, so a malformed
 *  frame must never throw out of the socket handler. Returns an error string, or null when shape-safe. */
/** A trail EXPLAINS an outcome, so the most recent decisions are the ones worth keeping. Bounded because a
 *  pathological worker could otherwise stream `job:state` until the process runs out of memory. */
const TRAIL_CAP = 200;

/**
 * Prefix of the per-model capability token a worker advertises for each separator it can run.
 *
 * Mirrored in the worker's `adapters/zoo.MODEL_CAPABILITY_PREFIX`. Routing a job to a box that has a
 * particular checkpoint needs no new machinery because of this: `planAssignments` already matches one
 * capability string against a worker's list.
 */
export const MODEL_CAPABILITY_PREFIX = 'stems:model:';

/** A device or backend NAME as a worker reports it (`cpu`, `cuda:1`, `torch`, `mlx`): short, and nothing a
 *  path or a hostname could hide in, since it is stored and shown on /metrics verbatim. */
const PROFILE_NAME = /^[a-z0-9][a-z0-9_:.-]{0,31}$/i;
/** A resolved fact (`htdemucs`, `bs-roformer-1297`, `large-v3`): stored verbatim, so bounded. */
const FACT_MAX = 128;

const isProfileName = (v: unknown): v is string => typeof v === 'string' && PROFILE_NAME.test(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4096;

/** The well-shaped part of a hello's profile. A bad field is DROPPED rather than refusing the frame: the
 *  profile is a diagnostic, and a diagnostic must never fail a handshake. */
export function workerProfile(
	msg: Partial<
		Record<
			'backend' | 'device' | 'threads' | 'demucsJobs' | 'concurrency' | 'asrCompute' | 'warmup' | 'handSet',
			unknown
		>
	>
): WorkerProfile {
	const out: WorkerProfile = {};
	if (isProfileName(msg.backend)) out.backend = msg.backend;
	if (isProfileName(msg.device)) out.device = msg.device;
	if (isCount(msg.threads)) out.threads = msg.threads;
	if (isCount(msg.demucsJobs)) out.demucsJobs = msg.demucsJobs;
	if (isCount(msg.concurrency)) out.concurrency = msg.concurrency;
	if ((ASR_COMPUTE_TYPES as readonly unknown[]).includes(msg.asrCompute)) out.asrCompute = msg.asrCompute as string;
	if (typeof msg.warmup === 'boolean') out.warmup = msg.warmup;
	// Known names only, once each and in one order, so the stored list is short and can be shown as is.
	const handSet = msg.handSet;
	if (Array.isArray(handSet) && handSet.length <= 32)
		out.handSet = PROFILE_SETTINGS.filter((name) => handSet.includes(name));
	return out;
}

/** The string facts of a completion that are actually strings. Anything else (a null, an object, a number)
 *  is dropped, so it can neither blank what dispatch already recorded nor land in a text column unchecked.
 *  `backend` and `device` are held to hello's `PROFILE_NAME`, since they overwrite what hello stamped. */
export function resolvedFacts(facts: unknown): AttemptFacts {
	if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return {};
	const f = facts as Record<string, unknown>;
	const out: AttemptFacts = {};
	for (const k of ['engine', 'model', 'asrModel', 'syncMode'] as const) {
		const v = f[k];
		if (typeof v === 'string' && v.length > 0 && v.length <= FACT_MAX) out[k] = v;
	}
	for (const k of ['backend', 'device'] as const) {
		const v = f[k];
		if (isProfileName(v)) out[k] = v;
	}
	// What this job's separator got once the cores were split between the jobs running, which a lone song
	// and two at once differ on; it overwrites the boot profile dispatch stamped. Held to hello's bounds.
	for (const k of ['threads', 'demucsJobs'] as const) {
		const v = f[k];
		if (isCount(v)) out[k] = v;
	}
	// A known reason only: it reaches the song page, so free text from a worker never does.
	if ((LYRICS_NOTES as readonly unknown[]).includes(f.lyricsNote)) out.lyricsNote = f.lyricsNote as string;
	return out;
}

/** Stages read from one completion; the worker sends about a dozen. */
const STAGES_MAX = 32;
/** A stage's longest believable run: a day, longer than any job's ceiling. */
const STAGE_MS_MAX = 86_400_000;

/** `job:complete`'s `stages` as the attempt row may store them, or undefined for none. A worker's list is held to
 *  `STAGES_MAX` entries, each `ms` a finite count from 0 to `STAGE_MS_MAX` (anything else is dropped), and the
 *  known names only (`WORKER_STAGES`, each with a speed-page label): an unknown name, a newer worker's step, is
 *  summed into one `other` row, so it neither reaches the page as raw text nor grows the list. An older worker
 *  sends none. */
export function attemptStagesJson(stages: unknown): string | undefined {
	if (!Array.isArray(stages)) return undefined;
	const spent = new Map<string, number>();
	for (const s of stages.slice(0, STAGES_MAX)) {
		if (!s || typeof s !== 'object') continue;
		const { stage, ms } = s as { stage?: unknown; ms?: unknown };
		if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > STAGE_MS_MAX) continue;
		const name = (WORKER_STAGES as readonly unknown[]).includes(stage) ? (stage as string) : 'other';
		spent.set(name, (spent.get(name) ?? 0) + Math.round(ms));
	}
	return spent.size ? JSON.stringify([...spent].map(([stage, ms]) => ({ stage, ms }))) : undefined;
}

export function validateWorkerMessage(msg: unknown): string | null {
	if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'malformed worker frame';
	const m = msg as Record<string, unknown>;
	if (typeof m.type !== 'string') return 'missing worker frame type';
	if (typeof m.workerId !== 'string' || m.workerId.length === 0) return 'missing workerId';
	switch (m.type) {
		case 'worker:hello':
			if (!Array.isArray(m.capabilities) || !m.capabilities.every((c) => typeof c === 'string'))
				return 'malformed capabilities';
			if (typeof m.concurrency !== 'number' || !Number.isFinite(m.concurrency)) return 'malformed concurrency';
			if (typeof m.version !== 'string') return 'malformed version';
			return null;
		case 'worker:catalogue':
			if (!Array.isArray(m.capabilities) || !m.capabilities.every((c) => typeof c === 'string'))
				return 'malformed capabilities';
			// Each offer must carry a usable token, because that token is what a job will name and what lands
			// in `job_attempts.model`. Everything else is display and may be absent.
			if (
				!Array.isArray(m.separators) ||
				!m.separators.every(
					(o) =>
						!!o &&
						typeof o === 'object' &&
						typeof (o as Record<string, unknown>).token === 'string' &&
						((o as Record<string, unknown>).token as string).length > 0
				)
			)
				return 'malformed separators';
			return null;
		case 'worker:heartbeat':
			if (typeof m.slotsFree !== 'number' || !Number.isFinite(m.slotsFree)) return 'malformed slotsFree';
			if (!Array.isArray(m.runningJobIds) || !m.runningJobIds.every((j) => typeof j === 'string'))
				return 'malformed runningJobIds';
			return null;
		case 'job:accept':
			if (typeof m.jobId !== 'string' || m.jobId.length === 0) return 'missing jobId';
			return null;
		case 'job:reject':
			if (typeof m.jobId !== 'string' || m.jobId.length === 0) return 'missing jobId';
			if (typeof m.reason !== 'string') return 'malformed reason';
			return null;
		case 'job:progress':
			if (typeof m.jobId !== 'string' || m.jobId.length === 0) return 'missing jobId';
			if (typeof m.stage !== 'string') return 'malformed stage';
			if (typeof m.pct !== 'number' || !Number.isFinite(m.pct)) return 'malformed pct';
			return null;
		case 'job:complete':
			if (typeof m.jobId !== 'string' || m.jobId.length === 0) return 'missing jobId';
			if (typeof m.mediaUri !== 'string') return 'malformed mediaUri';
			return null;
		case 'job:failed':
			if (typeof m.jobId !== 'string' || m.jobId.length === 0) return 'missing jobId';
			if (typeof m.error !== 'string') return 'malformed error';
			if (typeof m.retryable !== 'boolean') return 'malformed retryable';
			return null;
		case 'job:state':
			if (typeof m.jobId !== 'string' || m.jobId.length === 0) return 'missing jobId';
			if (typeof m.state !== 'string' || m.state.length === 0) return 'malformed state';
			if (typeof m.attempt !== 'number' || !Number.isFinite(m.attempt)) return 'malformed attempt';
			return null;
		case 'job:claim':
			if (!Array.isArray(m.jobIds) || !m.jobIds.every((j) => typeof j === 'string')) return 'malformed jobIds';
			return null;
		default:
			return 'unknown worker frame type';
	}
}

export class WorkerHub {
	#d: WorkerHubDeps;
	#config: LeaseConfig;
	/** First-unservable stamps, so the loop neither reprints its warning every pass nor loses the clock
	 *  UNSERVABLE_TTL_MS measures. Pruned on every terminal path or an id for a job that died while
	 *  queued leaks. */
	#unservableSince = new Map<string, number>();
	/** Per-job decision trails from `job:state`, bounded. Flushed to the attempt ledger on completion. */
	#trails = new Map<string, Array<Record<string, unknown>>>();
	/** What the room was last told by `canMake()` and `canFetch()`. TRUE at boot, inside the grace: after a core restart
	 *  the worker redials within seconds, and starting false flashed "can't make" on the TV until its hello landed. A
	 *  box with no worker says so once the grace runs out. */
	#verdict: Record<MakerVerdict, boolean> = { canMake: true, canFetch: true };
	/** Armed while the fleet lacks one and the room still reads it true (MAKER_GRACE_MS). */
	#grace: Record<MakerVerdict, ReturnType<typeof setTimeout> | null> = { canMake: null, canFetch: null };
	/** Stem files a re-separation replaced or lost, by song, deleted once the song is out of its turn (`settle`). */
	#stale = new Map<string, Set<string>>();
	/** Re-separations that finished while their song was playing: the TV reloads a changed src from 0, so the new
	 *  stems go in when the turn ends. Mirrored in `held_completions` (`jobs.hold`), so a restart keeps it (#1317). */
	#held: { job: Job; msg: Extract<WorkerMessage, { type: 'job:complete' }> }[] = [];
	/** Workers that refused a job as an action they do not know, so it is offered to another. */
	#unknownTo = new Map<string, Set<string>>();
	constructor(deps: WorkerHubDeps) {
		this.#d = deps;
		this.#config = deps.config ?? DEFAULT_LEASE_CONFIG;
		// Slot release is EVENT-keyed and covers REJECT/COMPLETE only; FAIL releases explicitly at its
		// own call site (#onFailed). See docs/SERVER.md#idempotency-and-the-process-cap.
		this.#d.jobs.setSlotReleaseHook((workerId) => this.#d.registry.releaseSlot(workerId));
		// Boot counts as a loss: nothing is connected yet. Armed directly, not via #reviewVerdicts, because app.ts's
		// settings sink is not wired until the hub is constructed.
		this.#armGrace('canMake');
		this.#armGrace('canFetch');
	}

	/** The room's downward-only quality ceiling resolved INTO `defaultEngine`/`defaultModel`, because
	 *  dispatch.ts reads those fields for both the dispatched params and the routing capability — a
	 *  demucs-capped process must not be sent to a roformer worker. Only the stems pairing is rewritten. */
	#processSettings(): GlobalSettings | undefined {
		const effective = this.#d.getSettings?.();
		if (!effective) return undefined;
		const { engine, model } = resolveProcessSeparator(effective);
		return { ...effective.global, defaultEngine: engine, defaultModel: model };
	}

	/** THE FOURTH TERMINAL PATH IS NOT THE HUB'S: the reaper fails a job whose lease expired for the last
	 *  time, and `JobReaper.onFailed` hands it to the same `reportTerminalFailure` epilogue. That bag was
	 *  assembled INLINE in app.ts and silently omitted `persist`, so a reaper-killed process settled its
	 *  stem gate in memory only and the next boot read 'queued' back out of the row — the exact defect
	 *  `#failureSinks`'s own note exists to prevent, reintroduced by re-assembling it at a second site.
	 *  Exposed rather than copied, so there is one bag and not two. */
	terminalFailureSinks(): TerminalFailureDeps {
		return this.#failureSinks();
	}

	/** The sink bag every terminal path here hands `reportTerminalFailure` — named ONCE so a worker
	 *  failure, a refused silent instrumental and the unservable TTL cannot settle through different
	 *  sinks (in particular so none of the three loses the durable `persist` half). */
	#failureSinks(): TerminalFailureDeps {
		return {
			broadcast: (e) => this.#d.broadcast(e),
			mediaById: this.#d.mediaById,
			persist: (mediaId) => this.#d.persistMedia?.(mediaId)
		};
	}

	/** Effects go through the injected sinks. */
	handle(msg: WorkerMessage): void {
		switch (msg.type) {
			case 'worker:hello':
				return this.#onHello(msg);
			case 'worker:catalogue':
				return this.#onCatalogue(msg);
			case 'worker:heartbeat':
				return this.#onHeartbeat(msg);
			case 'job:accept':
				return this.#onAccept(msg);
			case 'job:reject':
				return this.#onReject(msg);
			case 'job:progress':
				return this.#onProgress(msg);
			case 'job:complete':
				return this.#onComplete(msg);
			case 'job:failed':
				return this.#onFailed(msg);
			case 'job:state':
				return this.#onState(msg);
			case 'job:claim':
				return this.#onClaim(msg);
		}
	}

	/**
	 * Append one decision to the job's trail. DIAGNOSTIC ONLY — it never changes a job's status, so a lost
	 * frame costs an explanation rather than correctness.
	 *
	 * BOUNDED per job, because a pathological worker could otherwise stream frames until the process runs out
	 * of memory: a trail is an explanation, and the most recent decisions are the ones that explain an
	 * outcome. Kept in memory and flushed to the attempt ledger on completion, alongside `stages`.
	 */
	#onState(msg: Extract<WorkerMessage, { type: 'job:state' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		// Stale frames are dropped rather than recorded: a trail entry for a job this worker no longer owns
		// would attribute another worker's reasoning to it.
		if (!job || job.workerId !== msg.workerId) return;
		const trail = this.#trails.get(msg.jobId) ?? [];
		trail.push({
			state: msg.state,
			attempt: msg.attempt,
			...(msg.verdict ? { verdict: msg.verdict } : {}),
			...(msg.why ? { why: msg.why } : {}),
			...(msg.knob ? { knob: msg.knob } : {}),
			at: this.#d.now()
		});
		if (trail.length > TRAIL_CAP) trail.splice(0, trail.length - TRAIL_CAP);
		this.#trails.set(msg.jobId, trail);
	}

	/**
	 * Answer a `job:claim` — the PULL half of the ownership guard.
	 *
	 * Partitioned three ways because the worker acts differently on each: `owned` releases a publish,
	 * `revoked` is an ordinary reassignment, and `unknown` means the worker is running something this core
	 * has no row for — a real desync, and folding it into `revoked` would hide it.
	 *
	 * A job is OURS only when the row still names this worker AND is still running. A job that finished, was
	 * cancelled or was requeued is not this worker's to publish, even though the row exists.
	 */
	#onClaim(msg: Extract<WorkerMessage, { type: 'job:claim' }>): void {
		const owned: string[] = [];
		const revoked: string[] = [];
		const unknown: string[] = [];
		for (const jobId of msg.jobIds) {
			const job = this.#d.jobs.byId(jobId);
			if (!job) unknown.push(jobId);
			else if (job.workerId === msg.workerId && (job.status === 'running' || job.status === 'assigned'))
				owned.push(jobId);
			else revoked.push(jobId);
		}
		this.#d.toWorker(msg.workerId, { type: 'job:claim-ack', owned, revoked, unknown });
	}

	/** The PUSH half: tell a worker a job stopped being theirs, the moment it happens. */
	revoke(jobId: string, workerId: string | null | undefined, reason: string): void {
		if (!workerId) return;
		this.#d.toWorker(workerId, { type: 'job:revoked', jobId, reason });
	}

	/** The trail to persist: the streamed frames when there are any, else whatever the completion carried.
	 *  `undefined` when neither exists, so an absent trail stays absent rather than becoming `"[]"`. */
	#trailJson(jobId: string, reported: unknown): string | undefined {
		const streamed = this.#trails.get(jobId);
		if (streamed?.length) return JSON.stringify(streamed);
		if (Array.isArray(reported) && reported.length) return JSON.stringify(reported);
		return undefined;
	}

	/** The recorded trail for a job, oldest first. Emptied when the job leaves the hub. */
	trailOf(jobId: string): Array<Record<string, unknown>> {
		return this.#trails.get(jobId) ?? [];
	}

	/** Whether the sweep has already found no connected worker for this job. It broadcasts that only on FIRST sight,
	 *  so any later `media:status` for the same job must carry it, or the room reads the stall as cleared. */
	isUnservable(jobId: string): boolean {
		return this.#unservableSince.has(jobId);
	}

	/** Every capability some connected worker advertises — the set dispatch routes against. */
	#offered(): Set<string> {
		return new Set(this.#d.registry.list().flatMap((w) => w.capabilities));
	}

	/** `noMakerMedia` against this hub's workers and settings: what /api/library reports to a client that loads now. */
	noMakerMedia(entries: readonly { status: string; mediaId: string }[], offered = this.#offered()): string[] {
		const deps = { mediaById: this.#d.mediaById, jobs: this.#d.jobs, settings: this.#processSettings() };
		return noMakerMedia(entries, deps, offered);
	}

	/**
	 * Whether anything connected can make karaoke at the room's quality: some worker offers each step every song
	 * needs, by the same resolved capability the dispatch refusal routes by, so it is never more pessimistic than
	 * the refusal it predicts. Only a boolean leaves the hub: no worker ids, hosts or counts ride `queue:sync`.
	 */
	canMake(): boolean {
		return this.#verdict.canMake;
	}

	/** Whether anything connected can FETCH a search result (the room's fetcher, as dispatch routes `fetch`). A box
	 *  with no yt-dlp still makes library uploads, so this is its own boolean, with the same grace. */
	canFetch(): boolean {
		return this.#verdict.canFetch;
	}

	/** Moves each verdict toward what the fleet offers now: true at once, false only after MAKER_GRACE_MS without. */
	#reviewVerdicts(offered: Set<string>): void {
		const settings = this.#processSettings();
		this.#review(
			'canMake',
			MAKES_KARAOKE.every((step) => offered.has(requiredCapability(step, settings)))
		);
		this.#review('canFetch', offered.has(requiredCapability('fetch', settings)));
	}

	#review(key: MakerVerdict, now: boolean): void {
		const grace = this.#grace[key];
		if (now) {
			if (grace) clearTimeout(grace);
			this.#grace[key] = null;
			this.#setVerdict(key, true);
		} else if (this.#verdict[key] && !grace) this.#armGrace(key);
	}

	/** Counts from the LOSS: a later fleet change still without one neither restarts nor adds a clock. */
	#armGrace(key: MakerVerdict): void {
		const grace = setTimeout(() => {
			this.#grace[key] = null;
			this.#setVerdict(key, false);
		}, MAKER_GRACE_MS);
		// A hub in a test or a short-lived script must not keep the process alive for the grace.
		grace.unref?.();
		this.#grace[key] = grace;
	}

	#setVerdict(key: MakerVerdict, value: boolean): void {
		if (value === this.#verdict[key]) return;
		this.#verdict[key] = value;
		this.#d.onMakerChange?.();
	}

	/**
	 * What the fleet offers decides "no maker", and nothing else would tell a room that already holds a verdict. So on
	 * every change of what the fleet offers, each waiting song whose verdict flipped is re-sent:
	 * - was "no maker", is not: a plain failure. The song still needs a Try again, which now can work.
	 * - was not, is now (the last capable worker left): the failure with `unservable`, so live screens say what a
	 *   reload says, "Can't make new karaoke right now".
	 *
	 * STATELESS ON PURPOSE: it compares the fleet before and after, so a worker that leaves and rejoins re-tells it
	 * both ways, and so does the first join after a core restart (the registry starts empty). A second worker with
	 * the same capabilities changes nothing and says nothing.
	 *
	 * `restated`, not `requestedBy`: the singer was already told "try again" when the job died, and a second notice
	 * minutes later, once per rejoin of a flapping worker, would be noise. The status alone moves every screen.
	 *
	 * shortcut: a SETTINGS change re-tells nothing, though it moves the required capability (a room switched to a
	 * model a connected worker already offers clears "no maker" for a reload, not live; `canMake` waits for the next
	 * fleet change the same way). Admin-only and rare; call
	 * this from the settings write if it ever matters.
	 */
	#retellOnFleetChange(before: Set<string>): void {
		const after = this.#offered();
		this.#reviewVerdicts(after);
		if (after.size === before.size && [...after].every((c) => before.has(c))) return;
		const entries = this.#d.queueEntries();
		const was = new Set(this.noMakerMedia(entries, before));
		const now = new Set(this.noMakerMedia(entries, after));
		const tell = (mediaId: string, unservable: true | undefined) => {
			// With its row, like every failure: a phone that never fetched the song can still draw it.
			const media = this.#d.mediaById.get(mediaId);
			this.#d.broadcast({ type: 'media:status', mediaId, status: 'failed', pct: 0, unservable, restated: true, media });
		};
		for (const mediaId of was) if (!now.has(mediaId)) tell(mediaId, undefined);
		for (const mediaId of now) if (!was.has(mediaId)) tell(mediaId, true);
	}

	/** A worker's socket closed. `release` deregisters it (server.ts owns the socket map); the room is then told what
	 *  the fleet's loss changed. */
	workerLeft(release: () => void): void {
		const before = this.#offered();
		release();
		this.#retellOnFleetChange(before);
	}

	/**
	 * A worker's capability list, COLLAPSED for a log line.
	 *
	 * A worker offering the model zoo advertises ~137 capability tokens, 135 of them `stems:model:<token>`.
	 * Printed verbatim that is a 6 KB line that buries the two or three tokens anyone reads a join message
	 * for. So the per-model tokens are counted rather than listed, and the base capabilities print as before.
	 */
	static summariseCapabilities(capabilities: string[]): string {
		const models = capabilities.filter((c) => c.startsWith(MODEL_CAPABILITY_PREFIX));
		const base = capabilities.filter((c) => !c.startsWith(MODEL_CAPABILITY_PREFIX));
		const tail = models.length > 0 ? `,+${models.length} models` : '';
		return `${base.join(',') || 'none'}${tail}`;
	}

	/**
	 * A worker reported the models it can run. Applied to the registry, then dispatched — because a job may
	 * have been sitting unservable waiting for exactly this: `hasCapableWorker` was false for
	 * `stems:model:<token>` until this frame arrived.
	 */
	#onCatalogue(msg: Extract<WorkerMessage, { type: 'worker:catalogue' }>): void {
		const before = this.#offered();
		const applied = this.#d.registry.catalogue(msg.workerId, msg.capabilities, msg.separators, this.#d.now());
		if (!applied) return; // stale: the worker closed before its catalogue landed

		// ITS OWN LOG LINE, deliberately separate from the join message. The join happens seconds earlier and
		// this arrives asynchronously, so folding it into that line would mean either delaying the join
		// message or rewriting it. Two lines also read better: one says a worker appeared, one says what it
		// can do.
		const byArchitecture = new Map<string, number>();
		for (const offer of msg.separators) {
			const key = offer.architecture || 'unknown';
			byArchitecture.set(key, (byArchitecture.get(key) ?? 0) + 1);
		}
		const breakdown = [...byArchitecture.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([arch, n]) => `${arch} ${n}`)
			.join(', ');
		const best = msg.separators
			.filter((o) => typeof o.upstreamInstrumentalSdr === 'number')
			.sort((a, b) => (b.upstreamInstrumentalSdr ?? 0) - (a.upstreamInstrumentalSdr ?? 0))[0];
		// "upstream" is stated because it is NOT our measurement — see SeparatorOffer's doc comment.
		const top = best ? `; best upstream ${best.upstreamInstrumentalSdr?.toFixed(2)} dB (${best.token})` : '';
		console.log(`[hub] worker ${msg.workerId} offers ${msg.separators.length} separation models: ${breakdown}${top}`);
		this.#retellOnFleetChange(before);
		this.dispatch();
	}

	/** Worker (re)connected: register, send welcome handshake, then dispatch any waiting work. */
	#onHello(msg: Extract<WorkerMessage, { type: 'worker:hello' }>): void {
		const before = this.#offered();
		this.#d.registry.hello(
			msg.workerId,
			msg.capabilities,
			msg.concurrency,
			msg.version,
			this.#d.now(),
			msg.host,
			workerProfile(msg)
		);
		// `cpuCount` is the worker's EFFECTIVE count; `(contained)` marks a slice of a bigger box.
		const hw = msg.host
			? `${msg.host.accelerator ?? (msg.host.cuda ? 'cuda' : 'cpu')}/${msg.host.cpuCount ?? '?'}cpu${msg.host.contained ? ' (contained)' : ''}`
			: 'hardware unreported';
		console.log(
			`[hub] worker ${msg.workerId} joined: ${hw}, caps=[${WorkerHub.summariseCapabilities(msg.capabilities)}], slots=${msg.concurrency}`
		);
		this.#d.toWorker(msg.workerId, {
			type: 'worker:welcome',
			// HALF the progress lease: at the full value one dropped tick breaches the lease and the
			// reaper requeues a healthy process as `progress-lease-expired`.
			heartbeatIntervalSec: Math.floor(this.#config.progressLeaseMs / 1000 / 2),
			ackTimeoutSec: Math.floor(this.#config.ackTimeoutMs / 1000),
			mediaStore: this.#d.mediaStore ?? { kind: 'local' },
			// Core owns the storage layout, so core names the format rather than trusting each worker's env
			// to agree. A worker that publishes a different container writes a file whose recorded ref 404s.
			publishStemFormat: publishStemFormat()
		});
		this.#retellOnFleetChange(before);
		this.dispatch();
	}

	#onHeartbeat(msg: Extract<WorkerMessage, { type: 'worker:heartbeat' }>): void {
		this.#d.registry.heartbeat(msg.workerId, msg.slotsFree, this.#d.now());
	}

	/** assigned → running, stamp a fresh progress lease. */
	#onAccept(msg: Extract<WorkerMessage, { type: 'job:accept' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'assigned' || job.workerId !== msg.workerId) return; // stale
		const updated = this.#d.jobs.accept(msg.jobId, progressDeadline(this.#d.now(), this.#config), this.#d.now());
		this.#emitStatus(updated);
	}

	/** Worker declined (capability/transient) → back to queued, hold the worker, try another worker. */
	#onReject(msg: Extract<WorkerMessage, { type: 'job:reject' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'assigned' || job.workerId !== msg.workerId) return;
		// REJECT frees the slot via the machine's slot-release hook (reads the owner pre-write)...
		this.#d.jobs.requeue(msg.jobId, job.attempts, this.#d.now(), 'REJECT');
		// A worker older than core refuses an action it does not know, and would get it back every dispatch tick (one
		// attempt row each). It goes to a worker that has not refused it; with none left, the job ends saying what to do.
		const refusedBy = this.#unknownTo.get(msg.jobId) ?? new Set<string>();
		const cap = requiredCapability(job.jobType, this.#processSettings());
		if (msg.reason.startsWith('unknown action')) this.#unknownTo.set(msg.jobId, refusedBy.add(msg.workerId));
		const another = this.#d.registry.list().some((w) => !refusedBy.has(w.workerId) && w.capabilities.includes(cap));
		if (msg.reason.startsWith('unknown action') && !another) {
			this.#unknownTo.delete(msg.jobId);
			const failed = this.#d.jobs.fail(
				msg.jobId,
				`this worker does not know '${job.jobType}' jobs yet — update the worker to the same version as core`,
				this.#d.now()
			);
			reportTerminalFailure(failed, 'worker', this.#failureSinks());
		}
		// ...and the HOLD then backs off: a worker that refused "no free slots" got its slot back from the
		// release and was re-assigned the same job at network speed until its running job ended. Its next
		// heartbeat (sent right after a reject) restores the real count.
		this.#d.registry.hold(msg.workerId);
		this.dispatch();
	}

	/** running self-loop: refresh lease + rebroadcast the live progress bar. */
	#onProgress(msg: Extract<WorkerMessage, { type: 'job:progress' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		const hungSec = this.#hungSec(job);
		if (hungSec != null) {
			// Read like the reaper: revoke first, so the worker stops the engine (`_stop`) for a job no longer its.
			this.revoke(job.id, msg.workerId, 'failed');
			// Not retryable: the next attempt runs the same engine on the same song, and each would hang to its own
			// 1 h wall clock before the guest hears "didn't work".
			this.#onFailed({
				type: 'job:failed',
				workerId: msg.workerId,
				jobId: msg.jobId,
				error: `took far longer than usual (${Math.round(hungSec)}s) — stopped as hung`,
				retryable: false
			});
			return;
		}
		const updated = this.#d.jobs.progress(
			msg.jobId,
			{
				stage: msg.stage,
				// Never backwards within a stage: an older worker's keepalive sends 0 between the real figures, and
				// the bar would run back to the stage floor every 10 s (`process-progress.ts`'s own invariant).
				progressPct: job.stage === msg.stage ? Math.max(job.progressPct, msg.pct) : msg.pct,
				// A worker's own figure wins; today's workers send none, so core works it out from this box's history.
				etaSec: msg.etaSec ?? this.#etaFor(job),
				leaseExpiresAt: progressDeadline(this.#d.now(), this.#config)
			},
			this.#d.now()
		);
		this.#emitStatus(updated, msg.stage);
	}

	/** Seconds until the SONG is ready (`eta.ts`): the running step from runs on its own engine family and
	 *  model, the later steps from any. Null without a ledger, a length, or history for every step left. */
	#etaFor(job: Job): number | null {
		const ledger = this.#d.attempts;
		const open = ledger?.openFor(job.id);
		if (!ledger || open?.startedAt == null) return null;
		// Read wide, then matched, so another engine's runs cannot crowd this one's out of the sample.
		const current = sameEngine(ledger.recentReady(job.jobType, ETA_WINDOW), open.engine, open.model);
		return etaSec({
			audioSec: open.audioSec ?? this.#d.mediaById.get(job.mediaId)?.durationSec,
			elapsedSec: (this.#d.now() - open.startedAt) / 1000,
			current: workPerAudioSec(current.slice(0, ETA_SAMPLE)),
			later: laterSteps(job.jobType).map((type) => workPerAudioSec(ledger.recentReady(type, ETA_SAMPLE)))
		});
	}

	/** Seconds the open SEPARATION attempt has run once that is past `overrunAfterSec` of its estimate, else
	 *  null. Null with no history or no length too: an unmeasured step keeps today's bounds (the worker's own
	 *  wall clock, then the job ceiling), never a guessed one. */
	#hungSec(job: Job): number | null {
		// Separations only: fetch has its own silence limit, and align's history mixes every ASR model and sync mode.
		if (!separatorFor(job.jobType)) return null;
		const ledger = this.#d.attempts;
		const open = ledger?.openFor(job.id);
		if (!ledger || open?.startedAt == null || open.workerId == null) return null;
		// Narrower than the ETA's sample, because this one kills: only this worker's runs, so another box's speed
		// can't stop a healthy run. Matched by engine family, as the ETA is: the open attempt holds the request
		// ('demucs', 'audiosep') and history holds what the worker reported ('demucs-mlx', 'audiosep:<token>').
		const own = sameEngine(
			ledger.recentReady(job.jobType, ETA_WINDOW).filter((r) => r.workerId === open.workerId),
			open.engine,
			open.model
		);
		const rate = workPerAudioSec(own.slice(0, ETA_SAMPLE));
		const audioSec = open.audioSec ?? this.#d.mediaById.get(job.mediaId)?.durationSec;
		if (rate == null || audioSec == null || !(audioSec > 0)) return null;
		const elapsedSec = (this.#d.now() - open.startedAt) / 1000;
		return elapsedSec > overrunAfterSec(rate * audioSec) ? elapsedSec : null;
	}

	/** running → ready (terminal): publish the instrumental, free the slot, reconcile playback. */
	#onComplete(msg: Extract<WorkerMessage, { type: 'job:complete' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return this.#dropCancelled(msg, job); // stale

		// Verifying spawns ffmpeg and decodes the whole file, so it gates completion ASYNCHRONOUSLY and
		// re-checks staleness on entry — the reaper can fail this job while the probe is still decoding.
		const reported = msg.artifacts?.stems?.instrumental;
		if (publishesInstrumental(job.jobType) && !reported && !msg.mediaUri) {
			// A completion that names no instrumental anywhere is not one: readying it would derive a key for a
			// file nobody wrote, and the TV would 404 on a "ready" song. Retryable, like any worker fault.
			this.#onFailed({
				type: 'job:failed',
				workerId: msg.workerId,
				jobId: msg.jobId,
				error: 'the worker reported a completion with no instrumental',
				retryable: true
			});
			return;
		}
		if (this.#d.verifyInstrumental && publishesInstrumental(job.jobType) && reported) {
			void this.#d.verifyInstrumental(reported).then(
				(verdict) => {
					if (verdict === 'silent') this.#refuseSilentInstrumental(msg, reported);
					else this.#completeVerified(msg);
				},
				() => this.#completeVerified(msg) // probe threw — unmeasurable, not silent
			);
			return;
		}
		this.#completeVerified(msg);
	}

	/** Terminal and non-retryable: the same separator over the same source reproduces the same silence,
	 *  so a requeue would only burn every remaining attempt to arrive back here. */
	#refuseSilentInstrumental(msg: Extract<WorkerMessage, { type: 'job:complete' }>, ref: string): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return; // stale
		this.#unservableSince.delete(msg.jobId);
		this.#d.registry.releaseSlot(msg.workerId);
		const updated = this.#d.jobs.fail(
			msg.jobId,
			`instrumental measures as digital silence (${ref}) — refused rather than published as ready`,
			this.#d.now(),
			job.attempts + 1
		);
		console.warn(
			`[core] refused a silent instrumental for media ${job.mediaId}: the worker reported ${ref}, ` +
				'which measures at or below the silence floor. The song keeps the stems it had.'
		);
		// A refused re-separation's files are named nowhere else.
		if (reSeparates(job.jobType)) this.#retireOwnOutput(msg, job.mediaId);
		reportTerminalFailure(updated, 'worker', this.#failureSinks());
	}

	/** A completion for a re-separation that was cancelled (song deleted or evicted, or the job superseded, which
	 *  deletes its row) is ignored, but the files it wrote are named nowhere: they go. */
	#dropCancelled(msg: Extract<WorkerMessage, { type: 'job:complete' }>, job: Job | null): void {
		// A job that is still live, or finished, may be another worker's under the same names.
		const remakes = job && (reSeparates(job.jobType) || job.jobType === 'align-remake');
		if (job && (job.status === 'ready' || !isTerminalJob(job.status) || !remakes)) return;
		this.#retireOwnOutput(msg, job?.mediaId);
		for (const own of ownStemOutput(reportedLyricsRefs(msg), msg.jobId, job?.mediaId, [LYRICS_DIR, lyricsTagOf])) {
			const m = this.#d.mediaById.get(own.mediaId);
			const named = [m?.lyricsRef, m?.lyricsOverrideRef, ...(m?.lyricsCandidates ?? []).map((c) => c.ref)];
			if (!named.includes(own.ref)) this.#retire(own.mediaId, [own.ref]);
		}
	}

	/** A completion's own files that its song does not name, retired (`#retire`). */
	#retireOwnOutput(msg: Extract<WorkerMessage, { type: 'job:complete' }>, mediaId?: string): void {
		for (const own of ownStemOutput(reportedStemRefs(msg), msg.jobId, mediaId)) {
			if (!stemRefsOf(this.#d.mediaById.get(own.mediaId)).includes(own.ref)) this.#retire(own.mediaId, [own.ref]);
		}
	}

	/** Deletes `refs` once their song is out of its turn: a TV streams a file by range requests while it plays, and
	 *  preloads it on deck. Each delete is queued behind the song's sidecar write, so `meta/` never names a deleted file. */
	#retire(mediaId: string, refs: string[]): void {
		if (refs.length === 0) return;
		const set = this.#stale.get(mediaId) ?? new Set<string>();
		for (const ref of refs) set.add(ref);
		this.#stale.set(mediaId, set);
		this.#deleteStale();
	}

	/** Boot: the completions a restart found still held (`jobs.listHeld`), swapped in by `settle` once their song is
	 *  out of its turn. A row is dropped unless its job is `ready` and its message is that job's `job:complete`. */
	restoreHeld(): void {
		for (const row of this.#d.jobs.listHeld()) {
			const job = this.#d.jobs.byId(row.jobId);
			let msg: Extract<WorkerMessage, { type: 'job:complete' }> | null;
			try {
				msg = JSON.parse(row.message);
			} catch {
				msg = null;
			}
			const valid = job?.status === 'ready' && msg?.type === 'job:complete' && msg.jobId === row.jobId;
			if (!job || !msg || !valid) this.#d.jobs.release(row.jobId);
			else this.#held.push({ job, msg });
		}
	}

	/** The output tags whose stem files a song may have on disk that it does not name yet: its running
	 *  re-separations', and its held completions' (after `restoreHeld`), so the boot sweep spares both. */
	writingTags(mediaId: string): string[] {
		const live = (['stems-upgrade', 'stems-remake'] as const)
			.map((t) => this.#d.jobs.findLive(mediaId, t))
			.filter((j) => j && !isTerminalJob(j.status));
		const held = this.#held.filter((h) => h.job.mediaId === mediaId).map((h) => h.job);
		return [...live, ...held].map((j) => stemOutputTag(j!.id));
	}

	/** Boot: what a restart left (`staleStemsOnDisk`), deleted when the song is out of its turn. */
	retireStale(byMedia: ReadonlyMap<string, readonly string[]>): void {
		for (const [mediaId, refs] of byMedia) this.#retire(mediaId, [...refs]);
	}

	/** Every tick and on every retire: swap in what was held while its song played, then delete what no song in
	 *  its turn still needs. */
	settle(): void {
		const playing = this.#playingMediaId();
		const held = this.#held;
		this.#held = held.filter((h) => h.job.mediaId === playing);
		for (const h of held) if (h.job.mediaId !== playing) this.#swapHeld(h.job, h.msg);
		this.#deleteStale();
	}

	#playingMediaId(): string | undefined {
		const current = this.#d.currentEntryId?.() ?? null;
		return current ? this.#d.queueEntries().find((e) => e.id === current)?.mediaId : undefined;
	}

	#deleteStale(): void {
		const entries = this.#d.queueEntries();
		const current = this.#d.currentEntryId?.() ?? null;
		for (const [mediaId, refs] of this.#stale) {
			if (inTurn(mediaId, entries, current)) continue;
			this.#stale.delete(mediaId);
			const doomed = [...refs];
			void queueSidecarTask(mediaId, async () => this.#d.deleteRefs?.(doomed));
		}
	}

	#swapHeld(job: Job, msg: Extract<WorkerMessage, { type: 'job:complete' }>): void {
		this.#d.jobs.release(job.id);
		// Deleted or evicted meanwhile: nothing to swap into, so its files are lost output.
		if (!this.#d.mediaById.get(job.mediaId)?.instrumentalRef) return this.#retireOwnOutput(msg, job.mediaId);
		this.#applyCompletion(job, msg, this.#processSettings());
		this.#d.onMediaReady?.(job.mediaId);
	}

	/** The completion body proper, reached once the reported instrumental is not measurably silent. */
	#completeVerified(msg: Extract<WorkerMessage, { type: 'job:complete' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return; // stale
		this.#unservableSince.delete(msg.jobId); // terminal — prune any stale unservable tracking
		// MUST precede `complete`, which seals the attempt row; a sealed row is never written again.
		this.#d.attempts?.reportFacts(msg.jobId, {
			...resolvedFacts(msg.facts),
			stages: attemptStagesJson(msg.stages),
			selection: msg.selection ? JSON.stringify(msg.selection) : undefined,
			// The worker sends its trail on completion AND streams it as `job:state`; prefer the streamed one,
			// which survives a worker that died before reporting. Same storage reasoning as `stages`: one JSON
			// column, read whole to explain one attempt, never queried inside.
			trail: this.#trailJson(msg.jobId, msg.trail)
		});
		this.#trails.delete(msg.jobId);
		this.#unknownTo.delete(msg.jobId);
		const settings = this.#processSettings();
		const hold = reSeparates(job.jobType) && this.#playingMediaId() === job.mediaId;
		const updated = hold
			? this.#d.jobs.completeHeld(msg.jobId, JSON.stringify(msg), this.#d.now())
			: this.#d.jobs.complete(msg.jobId, this.#d.now());
		if (hold) this.#held.push({ job, msg });
		else this.#applyCompletion(job, msg, settings);
		cleanJobWork(msg.jobId);
		// Follow-ups enqueue AFTER cleanJobWork, so each gets its own scratch dir.
		for (const next of followUps(job.jobType, settings)) {
			// `inheritsProcess` carries the process id AND the singer attribution together; see
			// docs/SERVER.md#idempotency-and-the-process-cap.
			this.#d.jobs.enqueue(
				job.mediaId,
				next,
				job.priority,
				this.#d.now(),
				inheritsProcess(next) ? job.processingId : undefined,
				inheritsProcess(next) ? (job.singerId ?? undefined) : undefined
			);
			if (next === 'align') markLyricsQueued(job.mediaId, this.#d.mediaById);
		}
		this.#emitStatus(updated);
		if (!hold) this.#d.onMediaReady?.(job.mediaId);
		this.dispatch();
	}

	/** What a completion changes on its song, persisted; a re-separation's replaced or lost files are retired. */
	#applyCompletion(
		job: Job,
		msg: Extract<WorkerMessage, { type: 'job:complete' }>,
		settings: GlobalSettings | undefined
	): void {
		const separator = separatorFor(job.jobType, settings);
		let replaced: string[] = [];
		let lost = false;
		if (publishesInstrumental(job.jobType)) {
			const before = stemRefsOf(this.#d.mediaById.get(job.mediaId));
			// Every setter below is guarded on `accepted`: markMediaReady returns false for a stems-upgrade
			// that does not outrank the published separator, and a refusal must change NOTHING — an
			// unguarded setMediaSongProfile would wipe the song's existing key and vocal range.
			const accepted = markMediaReady(
				job.mediaId,
				this.#d.mediaById,
				msg.artifacts?.stems?.instrumental,
				separator,
				job.jobType === 'stems-remake'
			);
			if (accepted) {
				setMediaVocals(job.mediaId, msg.artifacts?.stems?.vocals, this.#d.mediaById);
				// Read through its DECLARED wire field. An absent mix clears the ref AND deletes the file,
				// or the next boot's backfill re-adopts a mix built from the stems this frame replaced.
				if (!setMediaGuideMix(job.mediaId, msg.artifacts?.stems?.guideMix, this.#d.mediaById)) {
					void this.#d.discardGuideMix?.(job.mediaId);
				}
				// A SIBLING of `stems`, not a member, and written even on an empty report: its PRESENCE
				// alone completes the stems gate (gates.ts).
				setMediaSongProfile(job.mediaId, msg.artifacts?.songProfile, this.#d.mediaById);
			}
			if (reSeparates(job.jobType)) {
				const live = stemRefsOf(this.#d.mediaById.get(job.mediaId));
				replaced = before.filter((ref) => !live.includes(ref));
				lost = !accepted;
			}
		}
		// Before the caller's cleanJobWork: the kept download lives under `audio/`, not the scratch dir it deletes.
		if (job.jobType === 'fetch') {
			setMediaOriginal(job.mediaId, msg.mediaUri, msg.artifacts?.original?.bytes, this.#d.mediaById);
		}
		applyAnnotation(job.mediaId, this.#d.mediaById, msg.artifacts?.annotation);
		// A lyrics remake swaps its whole set in (`remakeMediaLyrics`); everything else merges.
		let staleLyrics: string[] = [];
		if (job.jobType === 'align-remake') {
			const m = this.#d.mediaById.get(job.mediaId);
			const had = new Set([m?.lyricsRef, ...(m?.lyricsCandidates ?? []).map((c) => c.ref)]);
			const tag = stemOutputTag(job.id);
			const own = (ref: string) =>
				ref.startsWith(LYRICS_DIR) && lyricsTagOf(job.mediaId, ref.slice(LYRICS_DIR.length)) === tag;
			// What the song named before, or this job's own documents: never another file a worker names.
			staleLyrics = remakeMediaLyrics(job.mediaId, msg.artifacts?.lyrics?.candidates, this.#d.mediaById).filter(
				(ref) => had.has(ref) || own(ref)
			);
		} else {
			setMediaLyrics(job.mediaId, msg.artifacts?.lyrics?.uri, this.#d.mediaById, msg.artifacts?.lyrics?.candidates);
		}
		// The gate is satisfied by align having RUN, not by it having found words. After setMediaLyrics,
		// so the artifact is already attached when there is one.
		if (job.jobType === 'align') settleLyricsGate(job.mediaId, this.#d.mediaById);
		this.#d.persistMedia?.(job.mediaId);
		// After the persist, so each delete queues behind the sidecar write it makes.
		this.#retire(job.mediaId, replaced);
		if (lost) this.#retireOwnOutput(msg, job.mediaId);
		// Not held for the turn: the TV reads a lyrics document whole, once, and swaps a changed one in at a gap.
		const doomed = staleLyrics;
		if (doomed.length > 0) void queueSidecarTask(job.mediaId, async () => this.#d.deleteRefs?.(doomed));
	}

	/** running → requeue (retryable, attempts left) or failed (terminal). Frees the slot either way. */
	#onFailed(msg: Extract<WorkerMessage, { type: 'job:failed' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		this.#unservableSince.delete(msg.jobId); // terminal or requeue — prune stale unservable tracking
		this.#unknownTo.delete(msg.jobId);
		const attempts = job.attempts + 1;
		if (msg.retryable && !attemptsExhausted(attempts, job.maxAttempts)) {
			// Released EXPLICITLY, not via the slot-release hook, which never fires for FAIL or
			// LEASE_EXPIRED — the reaper's dead-worker paths share those events and must not double-free a
			// slot the registry reclaims itself. The `workerId` guard above proves this worker is alive.
			this.#d.registry.releaseSlot(msg.workerId);
			this.#d.jobs.requeue(msg.jobId, attempts, this.#d.now());
			this.dispatch();
		} else {
			this.#d.registry.releaseSlot(msg.workerId); // same explicit release, same reason as above
			const updated = this.#d.jobs.fail(msg.jobId, msg.error, this.#d.now(), attempts);
			// An unsettled gate makes the song unsingable forever, so all three fail paths route through
			// this one epilogue (see reportTerminalFailure).
			reportTerminalFailure(updated, 'worker', this.#failureSinks());
		}
	}

	/**
	 * Tracks jobs no connected worker can serve, and fails one once it has been unservable for
	 * UNSERVABLE_TTL_MS. Separate from assignment because "waiting for a slot" and "no worker can EVER run
	 * this" must stay distinguishable: conflated, a missing capability reads as a hung worker with the song
	 * at 0% forever.
	 */
	#sweepUnservable(queued: Job[], workers: WorkerSession[], capabilityFor: CapabilityFor, now: number): void {
		const ttlSec = Math.round(UNSERVABLE_TTL_MS / 1000);
		for (const job of queued) {
			if (hasCapableWorker(job, workers, capabilityFor)) continue;
			const cap = capabilityFor(job);
			const since = this.#unservableSince.get(job.id);
			if (since !== undefined) {
				if (now - since < UNSERVABLE_TTL_MS) continue;
				const updated = this.#d.jobs.fail(job.id, `${UNSERVABLE_ERROR_PREFIX} '${cap}' within ${ttlSec}s`, now);
				this.#unservableSince.delete(job.id);
				reportTerminalFailure(updated, 'unservable', this.#failureSinks());
				continue;
			}
			this.#unservableSince.set(job.id, now);
			console.warn(
				`[hub] job ${job.id} (${job.jobType}) needs capability '${cap}' and NO connected worker ` +
					`advertises it — it will stay queued until one does or ${ttlSec}s elapse. ` +
					`Connected: ${workers.length === 0 ? 'none' : workers.map((w) => `${w.workerId}[${WorkerHub.summariseCapabilities(w.capabilities)}]`).join(' ')}`
			);
			// Only tell the ROOM when the stall blocks singing: broadcasting 'queued' for an unservable
			// `align` on a playable song would regress a ready row to processing on every phone.
			const media = this.#d.mediaById.get(job.mediaId);
			if (media?.instrumentalRef) continue;
			this.#d.broadcast({
				type: 'media:status',
				mediaId: job.mediaId,
				status: mediaStatusFor(job),
				pct: job.progressPct,
				unservable: true
			});
		}
	}

	/** Plans assignments against live capacity, then per job: assign (ack lease) + claim slot + send
	 *  job:assign. Idempotent — safe after any event that frees capacity or enqueues work. */
	dispatch(): void {
		const queued = this.#d.jobs.listByStatus('queued');
		if (queued.length === 0) return;
		const workers = this.#d.registry.list();
		const now = this.#d.now();

		// Routed by the SETTINGS-resolved capability (e.g. stems:roformer), not the bare job type, so a
		// room-lowered process quality reaches a matching worker.
		const settings = this.#processSettings();
		const capabilityFor = (j: { jobType: JobType }) => requiredCapability(j.jobType, settings);

		this.#sweepUnservable(queued, workers, capabilityFor, now);

		const entries = this.#d.queueEntries();
		const current = this.#d.currentEntryId?.() ?? null;
		const runnable = queued.filter((j) => !waitsForTurn(j, entries, current));
		const refused = (jobId: string, workerId: string) => this.#unknownTo.get(jobId)?.has(workerId) === true;
		for (const { jobId, workerId } of planAssignments(runnable, workers, capabilityFor, refused)) {
			this.#unservableSince.delete(jobId); // it found a worker; a later stall is a fresh event
			const pending = this.#d.jobs.byId(jobId);
			if (!pending) continue; // vanished between planning and dispatch
			const media = this.#d.mediaById.get(pending.mediaId);
			const params = assignParams(pending.jobType, media, settings, pending.id);
			// The REQUEST, not the truth: a worker's own resolved model overwrites these via reportFacts. The
			// worker's profile is stamped HERE so a failed or abandoned attempt still says what it ran on.
			const profile = this.#d.registry.get(workerId)?.profile ?? {};
			const job = this.#d.jobs.assign(jobId, workerId, ackDeadline(now, this.#config), now, {
				backend: profile.backend ?? null,
				device: profile.device ?? null,
				threads: profile.threads ?? null,
				concurrency: profile.concurrency ?? null,
				demucsJobs: profile.demucsJobs ?? null,
				asrCompute: profile.asrCompute ?? null,
				handSet: profile.handSet?.join(',') ?? null,
				engine: params.engine ?? null,
				model: params.model ?? null,
				asrModel: params.asrModel ?? null,
				syncMode: params.syncMode ?? null,
				audioSec: media?.durationSec ?? null
			});
			this.#d.registry.claimSlot(workerId);
			this.#d.toWorker(workerId, {
				type: 'job:assign',
				jobId: job.id, // the span id
				processingId: job.processingId, // the trace id across a chained fetch→stems→align run
				mediaId: job.mediaId,
				jobType: job.jobType,
				sourceUri: assignSourceUri(pending.jobType, media, this.#d.getSettings?.()?.global.defaultFetcher),
				params
			});
		}
	}

	/** Broadcasts where the SONG is, never the job's own status — media-status.ts owns that translation,
	 *  and a terminal completion asks the MEDIA's gates via `completedStatusFor`. */
	#emitStatus(job: Job, stage?: MediaStatus): void {
		const media = this.#d.mediaById.get(job.mediaId);
		if (!shouldBroadcastProcess(job, media)) return;
		const status = job.status === 'ready' ? completedStatusFor(job, media) : mediaStatusFor(job, stage);
		this.#d.broadcast({
			type: 'media:status',
			mediaId: job.mediaId,
			status,
			// A finished step's 100 is not the NEXT step's: sent with it, the bar sat at that step's top and fell
			// back when the next job's first figure arrived.
			pct: job.status === 'ready' && status !== 'ready' ? 0 : job.progressPct,
			etaSec: job.etaSec ?? undefined,
			// Carried on every stage, not only on `failed`: this is the ONE emitter for a worker-reported
			// outcome, and a field set on some stages and not others is a field the next reader has to go
			// read this function to trust. Only the client's failure NOTICE gates on it today.
			requestedBy: job.singerId ?? undefined
		});
	}
}
