// Worker hub — the I/O brain of the dial-home protocol (§5). Bridges the in-memory WorkerRegistry,
// the pure dispatcher (dispatch.ts), the durable JobRepository, and lease policy.
// Decoupled from Bun.serve like realtime/hub.ts: it takes a `toWorker` sink (send a WorkerCommand
// to one worker) + a `broadcast` sink (media:status to phones/TV), so it unit-tests with no socket.
//
// Flow: worker:hello → welcome + dispatch; job:accept/progress/complete/failed drive the ledger;
// each lifecycle change rebroadcasts media:status so phones show the live "Separating… 68%" bar.

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
	EffectiveSettings
} from '@encore/shared';
import { sourceUriFor, resolveCookSeparator } from '@encore/shared';
import type { JobRepository } from './repository';
import type { AttemptLedger } from './attempts';
import { WorkerRegistry } from './registry';
import { planAssignments, assignParams, followUps, requiredCapability, separatorFor, publishesInstrumental, inheritsCook, hasCapableWorker } from './dispatch';
import {
	markMediaReady,
	setMediaLyrics,
	setMediaVocals,
	setMediaSongProfile,
	applyAnnotation,
	settleLyricsGate,
	reportTerminalFailure,
	markLyricsQueued
} from './make-karaoke';
import { cleanJobWork } from '../media/migrate-layout';
import { ackDeadline, progressDeadline, attemptsExhausted, DEFAULT_LEASE_CONFIG, type LeaseConfig } from './leases';
import { completedStatusFor, mediaStatusFor, shouldBroadcastCook } from './media-status';

export type ToWorker = (workerId: string, cmd: WorkerCommand) => void;
export type Broadcast = (event: ServerEvent) => void;

/**
 * How long a job may sit continuously unservable (no connected worker advertises its capability)
 * before it is moved to a terminal `failed` state. Without a ceiling such a job parks `queued`
 * forever: it never reaches a terminal state, so the TV and phone wait indefinitely on a song that
 * can never cook. Two minutes is long enough to ride out a worker restart or a fleet that is still
 * coming up, short enough that a genuinely unservable job surfaces as failed rather than hanging.
 */
const UNSERVABLE_TTL_MS = 120_000;

export interface WorkerHubDeps {
	jobs: JobRepository;
	/** Per-attempt history. Optional so the hub still unit-tests bare; app.ts wires it. */
	attempts?: AttemptLedger;
	registry: WorkerRegistry;
	/** Resolve a media's source URI (youtube id / file key) so the worker can pull it. */
	mediaById: Map<string, Media>;
	toWorker: ToWorker; // send a WorkerCommand to ONE worker session
	broadcast: Broadcast; // media:status to the whole room
	/** Fired AFTER a media flips to ready (stems done): lets the core reconcile playback so a held
	 *  song plays at its fair slot if the room idled while it cooked. Optional. */
	onMediaReady?: (mediaId: string) => void;
	/** Persist a media after its artifacts change (durable catalog). Optional so the hub still
	 *  unit-tests with no DB; app.ts wires it to MediaRepository.upsert. */
	persistMedia?: (mediaId: string) => void;
	/** Room+global separator settings, read live at assign time. EFFECTIVE, not just global: the room
	 *  can lower the cook quality below the global default (a downward-only ceiling), and that ceiling
	 *  has to reach the engine a stems job is dispatched with AND the capability it is routed by.
	 *  Optional so the hub still unit-tests without settings (dispatch falls back to shared defaults). */
	getSettings?: () => EffectiveSettings;
	now: () => number;
	config?: LeaseConfig;
	mediaStore?: MediaStoreConfig;
}

/**
 * Validate an inbound worker frame BEFORE anything reads a field off it. Returns an error string
 * (frame rejected, drop it) or null (frame is shape-safe to `handle`). Mirrors validateCommand in
 * realtime/hub.ts for the CLIENT-event family: server.ts:message() JSON.parsed a role=worker frame
 * inside a try/catch and then read fields with NO validation, so a hostile/broken frame — reachable
 * UNAUTHENTICATED when ENCORE_WORKER_TOKEN is unset — threw out of the socket handler on the first
 * unguarded read. Three throw sites this closes:
 *   - `JSON.parse('null')` succeeds, then `'workerId' in msg` (server.ts) throws on `null`;
 *   - a `worker:hello` with `capabilities: 1` reaches `[...capabilities]` in registry.hello and throws;
 *   - a `worker:hello` with `capabilities: 'stems'` spreads the STRING then `.join(',')` mislogs/mishandles.
 * The frame family carrying DISPATCH AUTHORITY is validated exactly like the client family it sits beside.
 * We check only the envelope + the fields each handler dereferences; the stale-frame guards
 * (`!job || status/workerId mismatch`) still defend the job lifecycle once jobId/workerId are strings.
 */
export function validateWorkerMessage(msg: unknown): string | null {
	// The ENVELOPE first — a non-null object with a known discriminant. `JSON.parse('null')` is the
	// literal null that made `'workerId' in msg` throw; a bare array or primitive is just as unusable.
	if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'malformed worker frame';
	const m = msg as Record<string, unknown>;
	if (typeof m.type !== 'string') return 'missing worker frame type';
	// Every worker frame identifies its sender, and every handler dereferences it (the socket also
	// keys itself by it for deregistration). A non-string workerId is rejected before any read.
	if (typeof m.workerId !== 'string' || m.workerId.length === 0) return 'missing workerId';
	switch (m.type) {
		case 'worker:hello':
			// capabilities is spread (`[...capabilities]`) and joined (`.join(',')`); a number throws on
			// the spread, a string spreads into characters and mis-registers. Require a string[].
			if (!Array.isArray(m.capabilities) || !m.capabilities.every((c) => typeof c === 'string'))
				return 'malformed capabilities';
			if (typeof m.concurrency !== 'number' || !Number.isFinite(m.concurrency)) return 'malformed concurrency';
			if (typeof m.version !== 'string') return 'malformed version';
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
		default:
			// An unknown type never reaches a handler (handle()'s switch has no default), but rejecting it
			// here keeps the boundary honest: only frames we can safely dispatch pass.
			return 'unknown worker frame type';
	}
}

export class WorkerHub {
	#d: WorkerHubDeps;
	#config: LeaseConfig;
	/** Job ids already reported as unservable, mapped to the time they FIRST became unservable, so a
	 *  dispatch loop that runs on every event does not reprint the same warning forever AND can fail a
	 *  job that has been unservable past UNSERVABLE_TTL_MS. Pruned on every terminal path (find-a-worker,
	 *  complete, fail, TTL-fail) so ids for jobs that die while still queued cannot leak. */
	#unservableSince = new Map<string, number>();
	constructor(deps: WorkerHubDeps) {
		this.#d = deps;
		this.#config = deps.config ?? DEFAULT_LEASE_CONFIG;
		// Slot accounting rides the job machine (#524 step 3). The hub owns the registry, so it wires
		// the repository's slot-release action here: a job leaving a worker's hands via a worker-reported
		// event (REJECT/COMPLETE/FAIL) frees that worker's concurrency slot from ONE place inside
		// `transition`, retiring the three hand-paired registry.releaseSlot() calls the handlers used to
		// carry. Reaper/boot (LEASE_EXPIRED/RECOVER) and CANCEL are deliberately not releasing events.
		this.#d.jobs.setSlotReleaseHook((workerId) => this.#d.registry.releaseSlot(workerId));
	}

	/**
	 * The GlobalSettings the pure dispatch layer should see, with the ROOM'S downward-only quality
	 * ceiling folded into the default stems pairing.
	 *
	 * `dispatch.ts` reasons in terms of `GlobalSettings.defaultEngine/defaultModel` for a stems cook —
	 * its assignParams, separatorFor, and (crucially) requiredCapability all read those two fields. The
	 * room's cap does not live there, so before this the ceiling `resolveCookSeparator` computes was
	 * built, tested, and never called: a room set to a lower quality was ignored, and the box always
	 * cooked at the global default. We resolve the effective pairing HERE and hand dispatch a global
	 * whose defaults ARE that pairing, so the lowered engine flows through the params the worker gets
	 * AND the capability it is routed by (a demucs-capped cook must not be sent to a roformer worker).
	 *
	 * ONLY the default (stems) pairing is rewritten. The upgrade axis, fetcher, and lyrics engines are
	 * left as the global set them — the room ceiling is a floor-lowering on the base cook, nothing else.
	 * Returns undefined when no settings are wired (unit tests), so dispatch keeps its shared-default
	 * behaviour unchanged.
	 */
	#cookSettings(): GlobalSettings | undefined {
		const effective = this.#d.getSettings?.();
		if (!effective) return undefined;
		const { engine, model } = resolveCookSeparator(effective);
		return { ...effective.global, defaultEngine: engine, defaultModel: model };
	}

	/** Handle one inbound worker message. Returns nothing — effects go through the injected sinks. */
	handle(msg: WorkerMessage): void {
		switch (msg.type) {
			case 'worker:hello':
				return this.#onHello(msg);
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
		}
	}

	/** Worker (re)connected: register, send welcome handshake, then dispatch any waiting work. */
	#onHello(msg: Extract<WorkerMessage, { type: 'worker:hello' }>): void {
		this.#d.registry.hello(msg.workerId, msg.capabilities, msg.concurrency, msg.version, this.#d.now(), msg.host);
		// Log what joined, hardware included. On a heterogeneous fleet this is how "why was that cook
		// slow" gets answered from the core's log without shelling into the worker. `cpuCount` is the
		// worker's EFFECTIVE count, so `(contained)` marks a box that was given a slice of a bigger one.
		const hw = msg.host
			? `${msg.host.accelerator ?? (msg.host.cuda ? 'cuda' : 'cpu')}/${msg.host.cpuCount ?? '?'}cpu${msg.host.contained ? ' (contained)' : ''}`
			: 'hardware unreported';
		console.log(
			`[hub] worker ${msg.workerId} joined: ${hw}, caps=[${msg.capabilities.join(',')}], slots=${msg.concurrency}`
		);
		this.#d.toWorker(msg.workerId, {
			type: 'worker:welcome',
			// Advertise HALF the progress lease, not the full lease. The worker's next `job:progress`
			// refreshes this lease (leases.ts progressLeaseMs), so a worker honouring the advertised
			// interval must have room for a dropped/late tick: at the full lease one missed tick breaches
			// the deadline and the reaper requeues a healthy cook as `progress-lease-expired`. This is the
			// same margin PR #300 pins on the worker side (LEASE_KEEPALIVE_SEC < progressLeaseMs / 2).
			heartbeatIntervalSec: Math.floor(this.#config.progressLeaseMs / 1000 / 2),
			ackTimeoutSec: Math.floor(this.#config.ackTimeoutMs / 1000),
			mediaStore: this.#d.mediaStore ?? { kind: 'local' }
		});
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

	/** Worker declined (capability/transient) → back to queued, free the slot, try another worker. */
	#onReject(msg: Extract<WorkerMessage, { type: 'job:reject' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'assigned' || job.workerId !== msg.workerId) return;
		// requeue via REJECT frees the worker's slot through the machine's slot-release hook (#524);
		// it reads the owner off the pre-write row, so the release still fires though the patch clears workerId.
		this.#d.jobs.requeue(msg.jobId, job.attempts, this.#d.now(), 'REJECT'); // worker declined; no attempt burned (never ran)
		this.dispatch();
	}

	/** running self-loop: refresh lease + rebroadcast the live progress bar. */
	#onProgress(msg: Extract<WorkerMessage, { type: 'job:progress' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		const updated = this.#d.jobs.progress(
			msg.jobId,
			{ stage: msg.stage, progressPct: msg.pct, etaSec: msg.etaSec ?? null, leaseExpiresAt: progressDeadline(this.#d.now(), this.#config) },
			this.#d.now()
		);
		this.#emitStatus(updated, msg.stage);
	}

	/** running → ready (terminal): flip media to the playable instrumental, free the slot, broadcast
	 *  ready, then let the core reconcile playback (a held song slots back at its fair position). */
	#onComplete(msg: Extract<WorkerMessage, { type: 'job:complete' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return; // stale
		this.#unservableSince.delete(msg.jobId); // terminal — prune any stale unservable tracking
		// Record what the worker ACTUALLY ran, and its per-stage split, BEFORE completing: `complete`
		// seals the attempt row, and a sealed row is never written again. Ordering matters here.
		this.#d.attempts?.reportFacts(msg.jobId, {
			...(msg.facts ?? {}),
			stages: msg.stages?.length ? JSON.stringify(msg.stages) : undefined
		});
		const updated = this.#d.jobs.complete(msg.jobId, this.#d.now());
		const settings = this.#cookSettings();
		// Flip the media to ready (instrumentalRef→what the worker wrote, stemStatus→
		// ready) so rotation's isEntryReady returns true and the held entry becomes playable.
		// Separation jobs report WHICH engine+model produced the artifact, so an upgrade can be refused
		// when it would not actually improve on what is published.
		const separator = separatorFor(job.jobType, settings);
		// ONLY separation publishes an instrumental. A `fetch` has produced nothing singable, and
		// markMediaReady derives the key when the worker reports none — so calling it here marked the
		// media ready with a key for a file that does not exist.
		if (publishesInstrumental(job.jobType)) {
			// markMediaReady REFUSES (returns false) when this is a stems-upgrade whose separator does
			// not outrank the published one. On a refusal NOTHING about the song should change — but the
			// two setters below were called unconditionally, and setMediaSongProfile normalizes an absent
			// profile to EMPTY_SONG_PROFILE, so a refused upgrade WIPED the detected key + vocal range off
			// a song that already had them (and could replace a good vocals ref with a worse one). Guard
			// both on the accept: a refused upgrade is a no-op, exactly as its name promises.
			const accepted = markMediaReady(job.mediaId, this.#d.mediaById, msg.artifacts?.stems?.instrumental, separator);
			if (accepted) {
				// The same separation also isolated the vocals — the guiding track. This artifact was
				// arriving on the wire and being dropped, which is why a cooked song had no guide even
				// though the file was sitting on disk next to the instrumental. Additive and independent:
				// a worker that could not encode vocals, or measured them as silence, reports none and the
				// song simply offers no guide.
				setMediaVocals(job.mediaId, msg.artifacts?.stems?.vocals, this.#d.mediaById);
				// The SAME separation also analysed the two stems for key + range and reported it as a third
				// artifact, a SIBLING of `stems` rather than a member of it (a profile is not a file). Persisted
				// here, at the boundary, because its PRESENCE completes the stems cook gate (gates.ts) — so
				// unlike the vocals ref this is written even when the worker found nothing, and
				// setMediaSongProfile normalizes the untrusted frame to a valid profile.
				//
				// Read through the DECLARED wire field, not structurally. This line previously reached into
				// `artifacts.stems.songProfile` while the worker published `artifacts.songProfile`, so the
				// value was always undefined — and with the gate requiring it, every separated song stalled at
				// "Separating vocals" permanently. Unit tests on both sides passed throughout, because each
				// mocked its own shape.
				setMediaSongProfile(job.mediaId, msg.artifacts?.songProfile, this.#d.mediaById);
			}
		}
		// A fetch may have identified the song. Applied under a never-regress rule so a later `medium`
		// cannot downgrade an existing `high` citation. Declined annotation leaves the normalizer's
		// values untouched, which is the honest outcome rather than a guess written as fact.
		applyAnnotation(job.mediaId, this.#d.mediaById, msg.artifacts?.annotation);
		// Attach word-timed lyrics if the job carried an align artifact (the TV overlay). Additive:
		// a stems-only complete leaves lyrics absent; an align complete populates lyricsRef.
		setMediaLyrics(job.mediaId, msg.artifacts?.lyrics?.uri, this.#d.mediaById, msg.artifacts?.lyrics?.candidates);
		// The lyrics GATE is satisfied by align having RUN, not by it having found words: a genuine
		// instrumental completes with no artifact and is still a finished song. Set after setMediaLyrics
		// so the artifact (when there is one) is already attached.
		if (job.jobType === 'align') settleLyricsGate(job.mediaId, this.#d.mediaById);
		// Persist the cooked media NOW (stems key + lyrics) so a restart finds the separated
		// song in the library instead of re-cooking it.
		this.#d.persistMedia?.(job.mediaId);
		// The worker's slot is freed by the machine's slot-release hook off the COMPLETE event (#524).
		// Job scratch is transient by contract — the intermediate WAVs in work/<jobId> are large
		// (a decoded source plus both separated stems) and nothing reads them after this point. Leaving
		// them is how 432MB accumulated under the old layout.
		cleanJobWork(msg.jobId);
		// Enqueue whatever this job unblocks (stems → align + score, and optionally a quality upgrade),
		// AFTER cleanJobWork so the follow-up gets its own scratch dir. Dedup on (mediaId, jobType) means
		// a re-cooked song cannot stack duplicate align jobs; it inherits the completed job's priority so
		// it stays as urgent as the song that needed it.
		for (const next of followUps(job.jobType, settings)) {
			// A chained step continues THIS cook so the song's end-to-end duration spans the whole run;
			// `stems-upgrade` deliberately starts its own (see inheritsCook).
			// Inherit the requester too: a follow-up of the SAME cook keeps its attribution; a new-cook
			// step (stems-upgrade) is background work and stays unattributed, imposing no per-singer cap.
			this.#d.jobs.enqueue(
				job.mediaId,
				next,
				job.priority,
				this.#d.now(),
				inheritsCook(next) ? job.cookId : undefined,
				inheritsCook(next) ? (job.singerId ?? undefined) : undefined
			);
			// Name the step the song is now waiting on, so the phone's cooking line can say "Timing
			// lyrics" instead of leaving a finished separation looking idle.
			if (next === 'align') markLyricsQueued(job.mediaId, this.#d.mediaById);
		}
		this.#emitStatus(updated);
		this.#d.onMediaReady?.(job.mediaId); // core reconciles playback (start if idle / preload)
		this.dispatch(); // picks up the follow-up too
	}

	/** running → requeue (retryable, attempts left) or failed (terminal). Frees the slot either way. */
	#onFailed(msg: Extract<WorkerMessage, { type: 'job:failed' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		this.#unservableSince.delete(msg.jobId); // terminal or requeue — prune stale unservable tracking
		const attempts = job.attempts + 1;
		if (msg.retryable && !attemptsExhausted(attempts, job.maxAttempts)) {
			// The terminal `failed` branch below frees the slot through the machine's slot-release hook
			// (FAIL is a worker-reported releasing event, #524). This RETRYABLE requeue cannot: it rides
			// `LEASE_EXPIRED`, the ONE requeue event the machine deliberately does not treat as a release
			// because the reaper's dead-worker requeue shares it and must NOT double-free a slot the
			// registry will reclaim on the next heartbeat. Here the worker is demonstrably alive (it just
			// sent this frame), so its slot IS free now and the immediate redispatch needs it back — the
			// one worker-reported requeue that stays an explicit release at the call site.
			this.#d.registry.releaseSlot(msg.workerId);
			this.#d.jobs.requeue(msg.jobId, attempts, this.#d.now());
			this.dispatch();
		} else {
			const updated = this.#d.jobs.fail(msg.jobId, msg.error, this.#d.now(), attempts);
			// A permanently failed cook must not hold the song hostage. Now that singing waits for the
			// stems/lyrics gates, leaving one unsettled means a single broken step — a worker OOM, a
			// model that will not load — makes the song unsingable forever, with no way out but a manual
			// DB edit. The terminal-failure epilogue (settle the right gate, tell the room, log one line,
			// reclaim scratch) is the SAME on all three fail paths (this one, the unservable-TTL branch,
			// and the reaper hook in app.ts), so it lives in ONE place — reportTerminalFailure (issue
			// #451). settleGatesForFailedJob (#90) is step 1 of it; a fourth fail path cannot reopen the
			// hole because there is no longer a fourth copy to drift.
			reportTerminalFailure(updated, 'worker', { broadcast: (e) => this.#d.broadcast(e), mediaById: this.#d.mediaById });
		}
	}

	/**
	 * Dispatch loop (§4): plan assignments for all queued jobs against live worker capacity, then
	 * for each: mark the job assigned (ack lease) + claim the worker's slot + send job:assign.
	 * Idempotent to call after any event that frees capacity or enqueues work.
	 */
	dispatch(): void {
		const queued = this.#d.jobs.listByStatus('queued');
		if (queued.length === 0) return;
		const workers = this.#d.registry.list();
		const now = this.#d.now();

		// A job's required capability is engine-derived (a roformer cook needs stems:roformer),
		// so route by the SETTINGS-resolved capability, not the bare job type. Uses the room-capped
		// settings so a lowered cook quality routes to the matching (lower) engine's workers.
		const settings = this.#cookSettings();
		const capabilityFor = (j: { jobType: JobType }) => requiredCapability(j.jobType, settings);

		// Separate "waiting for a free slot" from "no connected worker can EVER run this". Both leave
		// the job queued, and conflating them is how a song sits at 0% forever looking like a hung
		// worker: the real cause is that nothing in the fleet advertises the capability, which no
		// amount of waiting fixes. Reported once per job so the log names the missing capability
		// instead of the operator having to infer it.
		for (const job of queued) {
			if (hasCapableWorker(job, workers, capabilityFor)) continue;
			// First time we've seen this job unservable: stamp when, warn once. On a later pass, if it has
			// been continuously unservable past the TTL, move it to terminal `failed` so #emitStatus
			// broadcasts `failed` and the TV/phone can stop waiting on a song that can never cook.
			const since = this.#unservableSince.get(job.id);
			if (since !== undefined) {
				if (now - since >= UNSERVABLE_TTL_MS) {
					const cap = capabilityFor(job);
					const updated = this.#d.jobs.fail(
						job.id,
						`no connected worker advertised capability '${cap}' within ${Math.round(UNSERVABLE_TTL_MS / 1000)}s`,
						now
					);
					this.#unservableSince.delete(job.id); // terminal now — prune so the id cannot leak
					// Same terminal-failure epilogue as #onFailed and the reaper hook: settle the gate (else an
					// unservable align/fetch/stems leaves its gate mid-flight forever so readyToSing never
					// flips, #90), tell the room, log one uniform line (the capability rides in the job's
					// `reason`), and reclaim scratch — which this branch used to OMIT (issue #451).
					reportTerminalFailure(updated, 'unservable', { broadcast: (e) => this.#d.broadcast(e), mediaById: this.#d.mediaById });
				}
				continue; // already warned this stall; nothing else to do until the TTL fires
			}
			this.#unservableSince.set(job.id, now);
			const cap = capabilityFor(job);
			console.warn(
				`[hub] job ${job.id} (${job.jobType}) needs capability '${cap}' and NO connected worker ` +
					`advertises it — it will stay queued until one does or ${Math.round(UNSERVABLE_TTL_MS / 1000)}s elapse. ` +
					`Connected: ${workers.length === 0 ? 'none' : workers.map((w) => `${w.workerId}[${w.capabilities.join(',')}]`).join(' ')}`
			);
			// Only tell the ROOM when the stalled job is one that blocks singing. An `align` follow-up
			// on an already-published song is genuinely unservable, but the song is playable and
			// broadcasting a 'queued' status for it would regress a ready song to cooking on every
			// phone — a worse bug than the one being reported. Missing lyrics is not missing audio.
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

		for (const { jobId, workerId } of planAssignments(queued, workers, capabilityFor)) {
			this.#unservableSince.delete(jobId); // it found a worker; a later stall is a fresh event
			const pending = this.#d.jobs.byId(jobId);
			if (!pending) continue; // vanished between planning and dispatch
			const media = this.#d.mediaById.get(pending.mediaId);
			const params = assignParams(pending.jobType, media, settings);
			// Record WHAT WAS DISPATCHED onto the attempt, alongside the song's length so the cost can be
			// reported as a rate rather than raw seconds. These are the request, not yet the truth: a
			// worker that reports its own resolved model overwrites them (AttemptLedger.reportFacts).
			const job = this.#d.jobs.assign(jobId, workerId, ackDeadline(now, this.#config), now, {
				engine: params.engine ?? null,
				model: params.model ?? null,
				asrModel: params.asrModel ?? null,
				syncMode: params.syncMode ?? null,
				audioSec: media?.durationSec ?? null
			});
			this.#d.registry.claimSlot(workerId);
			this.#d.toWorker(workerId, {
				type: 'job:assign',
				jobId: job.id,
				// The cook this job belongs to, so the worker can tag its own logs and notes with the
				// same trace id the operator sees on /metrics/<mediaId> (#472). jobId is the span id;
				// cookId is the trace id across a chained fetch->stems->align run.
				cookId: job.cookId,
				mediaId: job.mediaId,
				jobType: job.jobType,
				sourceUri: media ? sourceUriFor(media, this.#d.getSettings?.()?.global.defaultFetcher) : '',
				params
			});
		}
	}

	/**
	 * Broadcast where the SONG is, for a job that just changed state.
	 *
	 * `status` is deliberately not the job's own status: a cook is three jobs walking one five-stop
	 * line the phone renders, and forwarding each job's private view of itself is what made the strip
	 * jump backwards twice per cook. media-status.ts owns that translation and carries the full account.
	 *
	 * A terminal completion passes through `completedStatusFor`, which asks the MEDIA's cook gates
	 * whether the song is finished — the only thing entitled to say 'ready'.
	 */
	#emitStatus(job: Job, stage?: MediaStatus): void {
		const media = this.#d.mediaById.get(job.mediaId);
		// A background upgrade on an already-singable song says nothing to the room; broadcasting would
		// flip every ready row back to "Making karaoke" for the length of the re-separation.
		if (!shouldBroadcastCook(job, media)) return;
		this.#d.broadcast({
			type: 'media:status',
			mediaId: job.mediaId,
			status: job.status === 'ready' ? completedStatusFor(job, media) : mediaStatusFor(job, stage),
			pct: job.progressPct,
			etaSec: job.etaSec ?? undefined
		});
	}
}

/** The URI a worker uses to pull the source (youtube → watch URL; local → file key). */
