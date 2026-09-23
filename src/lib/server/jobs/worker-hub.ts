// The I/O brain of the dial-home protocol. Bridges the in-memory WorkerRegistry, the pure dispatcher
// (dispatch.ts), the durable JobRepository, and lease policy. Decoupled from Bun.serve like
// realtime/hub.ts: takes a `toWorker` sink and a `broadcast` sink, so it unit-tests with no socket.
// Flow: worker:hello → welcome + dispatch; job:accept/progress/complete/failed drive the ledger and
// rebroadcast media:status.

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
} from '../../contract';
import { sourceUriFor, resolveProcessSeparator } from '../../contract';
import type { JobRepository } from './repository';
import type { AttemptLedger } from './attempts';
import { WorkerRegistry } from './registry';
import {
	planAssignments,
	assignParams,
	followUps,
	requiredCapability,
	separatorFor,
	publishesInstrumental,
	inheritsProcess,
	hasCapableWorker
} from './dispatch';
import {
	markMediaReady,
	setMediaLyrics,
	setMediaVocals,
	setMediaGuideMix,
	setMediaSongProfile,
	applyAnnotation,
	settleLyricsGate,
	reportTerminalFailure,
	markLyricsQueued
} from './process';
import { cleanJobWork } from '../media/migrate-layout';
import { ackDeadline, progressDeadline, attemptsExhausted, DEFAULT_LEASE_CONFIG, type LeaseConfig } from './leases';
import { completedStatusFor, mediaStatusFor, shouldBroadcastProcess } from './media-status';

export type ToWorker = (workerId: string, cmd: WorkerCommand) => void;
export type Broadcast = (event: ServerEvent) => void;

/** How long a job may sit continuously unservable before it's moved to terminal `failed` — without a
 *  ceiling it parks `queued` forever, waiting on a song that can never process. Two minutes is long
 *  enough to ride out a worker restart or a fleet still coming up, short enough that a genuinely
 *  unservable job surfaces as failed rather than hanging. */
const UNSERVABLE_TTL_MS = 120_000;

export interface WorkerHubDeps {
	jobs: JobRepository;
	/** Per-attempt history. Optional so the hub still unit-tests bare; app.ts wires it. */
	attempts?: AttemptLedger;
	registry: WorkerRegistry;
	/** Resolve a media's source URI (youtube id / file key) so the worker can pull it. */
	mediaById: Map<string, Media>;
	/** Deletes a media's guide-mix FILE, called when a completion frame carries no mix (the mix on disk
	 *  was built from stems this frame just replaced). Without it a stale-but-valid mix survives and the
	 *  next boot's backfill re-adopts it, pinning the room to the superseded separation. Optional; app.ts wires it. */
	discardGuideMix?: (mediaId: string) => void | Promise<void>;
	/** Measures a reported instrumental before publishing; `'silent'` REFUSES the completion. Defence in
	 *  depth against separation that succeeds but writes digital silence. `'unknown'` still PUBLISHES,
	 *  deliberately: an unmeasurable file (no ffmpeg on the host) is not silence, and refusing on it
	 *  would be a self-inflicted outage — only a POSITIVE silence measurement refuses. Optional; an
	 *  unwired core behaves exactly as before. */
	verifyInstrumental?: (ref: string) => Promise<'audible' | 'silent' | 'unknown'>;
	toWorker: ToWorker; // send a WorkerCommand to ONE worker session
	broadcast: Broadcast; // media:status to the whole room
	/** Fired AFTER a media flips to ready (stems done): lets the core reconcile playback so a held
	 *  song plays at its fair slot if the room idled while it processed. Optional. */
	onMediaReady?: (mediaId: string) => void;
	/** Persist a media after its artifacts change (durable catalog). Optional so the hub still
	 *  unit-tests with no DB; app.ts wires it to MediaRepository.upsert. */
	persistMedia?: (mediaId: string) => void;
	/** Room+global separator settings, read live at assign time. EFFECTIVE, not just global: the room's
	 *  downward-only quality ceiling must reach both the engine a stems job is dispatched with AND the
	 *  capability it is routed by. Optional; dispatch falls back to shared defaults without it. */
	getSettings?: () => EffectiveSettings;
	now: () => number;
	config?: LeaseConfig;
	mediaStore?: MediaStoreConfig;
}

/** Validates an inbound worker frame BEFORE anything reads a field off it, mirroring validateCommand's
 *  treatment of the CLIENT-event family in realtime/hub.ts. This frame family carries DISPATCH
 *  AUTHORITY and is reachable UNAUTHENTICATED whenever `ENCORE_WORKER_TOKEN` is unset, so a
 *  hostile/malformed frame must never throw out of the socket handler on an unguarded read. Checks
 *  only the envelope plus the fields each handler dereferences; the stale-frame guards
 *  (`!job || status/workerId mismatch`) still defend the job lifecycle once jobId/workerId are strings.
 *  Returns an error string (drop the frame) or null (shape-safe to `handle`). */
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
			return 'unknown worker frame type';
	}
}

export class WorkerHub {
	#d: WorkerHubDeps;
	#config: LeaseConfig;
	/** Ids reported unservable, mapped to when they FIRST became so, so the dispatch loop doesn't
	 *  reprint the same warning every pass and can still fail a job once it passes UNSERVABLE_TTL_MS.
	 *  Pruned on every terminal path so an id for a job that died while still queued cannot leak. */
	#unservableSince = new Map<string, number>();
	constructor(deps: WorkerHubDeps) {
		this.#d = deps;
		this.#config = deps.config ?? DEFAULT_LEASE_CONFIG;
		// The hub owns the registry, so it wires the repository's slot-release action here: a
		// worker-reported REJECT/COMPLETE frees that worker's slot from inside `transition` itself.
		// LEASE_EXPIRED/RECOVER and CANCEL are deliberately not releasing events (see repository.ts);
		// FAIL releases explicitly at its own call site below (#onFailed), not through this hook.
		this.#d.jobs.setSlotReleaseHook((workerId) => this.#d.registry.releaseSlot(workerId));
	}

	/** The GlobalSettings the pure dispatch layer should see, with the ROOM'S downward-only quality
	 *  ceiling folded into the default stems pairing. `dispatch.ts`'s assignParams/separatorFor/
	 *  requiredCapability all read `GlobalSettings.defaultEngine/defaultModel` directly, so the room's
	 *  cap must be resolved into THOSE fields here to reach both the params the worker gets and the
	 *  capability it's routed by (a demucs-capped process must not be sent to a roformer worker). ONLY
	 *  the default (stems) pairing is rewritten — upgrade/fetcher/lyrics engines are left as the global
	 *  set them. Returns undefined when no settings are wired, so dispatch keeps shared defaults. */
	#processSettings(): GlobalSettings | undefined {
		const effective = this.#d.getSettings?.();
		if (!effective) return undefined;
		const { engine, model } = resolveProcessSeparator(effective);
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
		// `cpuCount` is the worker's EFFECTIVE count, so `(contained)` marks a box given a slice of a bigger one.
		const hw = msg.host
			? `${msg.host.accelerator ?? (msg.host.cuda ? 'cuda' : 'cpu')}/${msg.host.cpuCount ?? '?'}cpu${msg.host.contained ? ' (contained)' : ''}`
			: 'hardware unreported';
		console.log(
			`[hub] worker ${msg.workerId} joined: ${hw}, caps=[${msg.capabilities.join(',')}], slots=${msg.concurrency}`
		);
		this.#d.toWorker(msg.workerId, {
			type: 'worker:welcome',
			// HALF the progress lease, not the full one: a worker honouring this interval needs room for a
			// dropped/late tick, or one missed heartbeat breaches the lease and the reaper requeues a
			// healthy process as `progress-lease-expired`.
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
		// REJECT frees the slot via the machine's slot-release hook (reads the owner pre-write).
		this.#d.jobs.requeue(msg.jobId, job.attempts, this.#d.now(), 'REJECT');
		this.dispatch();
	}

	/** running self-loop: refresh lease + rebroadcast the live progress bar. */
	#onProgress(msg: Extract<WorkerMessage, { type: 'job:progress' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		const updated = this.#d.jobs.progress(
			msg.jobId,
			{
				stage: msg.stage,
				progressPct: msg.pct,
				etaSec: msg.etaSec ?? null,
				leaseExpiresAt: progressDeadline(this.#d.now(), this.#config)
			},
			this.#d.now()
		);
		this.#emitStatus(updated, msg.stage);
	}

	/** running → ready (terminal): flip media to the playable instrumental, free the slot, broadcast
	 *  ready, then let the core reconcile playback (a held song slots back at its fair position). */
	#onComplete(msg: Extract<WorkerMessage, { type: 'job:complete' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return; // stale

		// Verifying spawns ffmpeg and decodes the whole file, so it can't run inline in this synchronous
		// handler — it gates completion asynchronously instead, and re-checks staleness on entry below
		// since the reaper could fail this job while the probe is still decoding.
		const reported = msg.artifacts?.stems?.instrumental;
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

	/** Refuses a completion whose reported instrumental MEASURES as digital silence. Terminal and
	 *  non-retryable: re-running the same separator over the same source reproduces the same silence, so
	 *  a requeue would just burn every remaining attempt to arrive back here. */
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
				'which measures at or below the silence floor. The song stays un-processed.'
		);
		reportTerminalFailure(updated, 'worker', {
			broadcast: (e) => this.#d.broadcast(e),
			mediaById: this.#d.mediaById,
			persist: (mediaId) => this.#d.persistMedia?.(mediaId)
		});
	}

	/** The completion body proper, reached once the reported instrumental is not measurably silent. */
	#completeVerified(msg: Extract<WorkerMessage, { type: 'job:complete' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return; // stale
		this.#unservableSince.delete(msg.jobId); // terminal — prune any stale unservable tracking
		// Record what the worker ACTUALLY ran, and its per-stage split, BEFORE completing: `complete`
		// seals the attempt row, and a sealed row is never written again. Ordering matters here.
		this.#d.attempts?.reportFacts(msg.jobId, {
			...(msg.facts ?? {}),
			stages: msg.stages?.length ? JSON.stringify(msg.stages) : undefined,
			selection: msg.selection ? JSON.stringify(msg.selection) : undefined
		});
		const updated = this.#d.jobs.complete(msg.jobId, this.#d.now());
		const settings = this.#processSettings();
		// The engine+model the separation actually used, so an upgrade can be refused when it wouldn't
		// improve on what's published (markMediaReady). Only separation publishes an instrumental — a
		// `fetch` completion has nothing singable, and calling markMediaReady for one would derive a key
		// for a file that doesn't exist (see dispatch.ts publishesInstrumental).
		const separator = separatorFor(job.jobType, settings);
		if (publishesInstrumental(job.jobType)) {
			// markMediaReady REFUSES (false) a stems-upgrade whose separator doesn't outrank the published
			// one, and a refusal must change NOTHING about the song — so the setters below are guarded on
			// `accepted` rather than called unconditionally (setMediaSongProfile in particular normalizes
			// an absent profile to EMPTY_SONG_PROFILE, which would wipe a song's existing key/vocal range).
			const accepted = markMediaReady(job.mediaId, this.#d.mediaById, msg.artifacts?.stems?.instrumental, separator);
			if (accepted) {
				// The same separation isolates vocals (the guiding track) — additive and independent: a
				// worker that can't encode vocals, or measures them as silence, reports none.
				setMediaVocals(job.mediaId, msg.artifacts?.stems?.vocals, this.#d.mediaById);
				// The guide mix folds both stems into one 4-channel file, read through its DECLARED wire
				// field rather than assumed structurally (as is `songProfile` below). Absent CLEARS the ref
				// rather than preserving it, since the mix is a DERIVATIVE of the stems this frame just
				// replaced; clearing also deletes the file, or the next boot's backfill would re-adopt the
				// stale-but-structurally-valid mix and pin the room to the superseded separation.
				if (!setMediaGuideMix(job.mediaId, msg.artifacts?.stems?.guideMix, this.#d.mediaById)) {
					void this.#d.discardGuideMix?.(job.mediaId);
				}
				// songProfile is a SIBLING of `stems`, not a member (not a file), and — unlike the vocals ref
				// — is written even when the worker found nothing, because its PRESENCE alone completes the
				// stems process gate (gates.ts); setMediaSongProfile normalizes the untrusted frame.
				setMediaSongProfile(job.mediaId, msg.artifacts?.songProfile, this.#d.mediaById);
			}
		}
		// Never-regress: a later `medium` annotation cannot downgrade an existing `high` citation: a
		// decline leaves the normalizer's values untouched rather than overwriting them with a guess.
		applyAnnotation(job.mediaId, this.#d.mediaById, msg.artifacts?.annotation);
		setMediaLyrics(job.mediaId, msg.artifacts?.lyrics?.uri, this.#d.mediaById, msg.artifacts?.lyrics?.candidates);
		// The lyrics GATE is satisfied by align having RUN, not by it having found words — a genuine
		// instrumental with no lyrics artifact is still a finished song. Set after setMediaLyrics so the
		// artifact, when there is one, is already attached.
		if (job.jobType === 'align') settleLyricsGate(job.mediaId, this.#d.mediaById);
		this.#d.persistMedia?.(job.mediaId);
		// Scratch is transient by contract: work/<jobId>'s intermediate WAVs are large and nothing reads
		// them after this point.
		cleanJobWork(msg.jobId);
		// AFTER cleanJobWork so the follow-up gets its own scratch dir; dedup on (mediaId, jobType) means a
		// re-processed song can't stack duplicate align jobs, and it inherits the completed job's priority.
		for (const next of followUps(job.jobType, settings)) {
			// `inheritsProcess` decides both the process id AND the singer attribution together: a chained
			// step (same process) keeps both (the cap itself only ever counts the root fetch/stems job,
			// see JobRepository.liveProcessMediaForSinger); a new-process step (`stems-upgrade`) gets
			// neither, staying unattributed background work.
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
		this.#d.onMediaReady?.(job.mediaId);
		this.dispatch();
	}

	/** running → requeue (retryable, attempts left) or failed (terminal). Frees the slot either way. */
	#onFailed(msg: Extract<WorkerMessage, { type: 'job:failed' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		this.#unservableSince.delete(msg.jobId); // terminal or requeue — prune stale unservable tracking
		const attempts = job.attempts + 1;
		if (msg.retryable && !attemptsExhausted(attempts, job.maxAttempts)) {
			// Released EXPLICITLY here, not via the machine's slot-release hook (which never fires for
			// FAIL or this requeue's LEASE_EXPIRED — the reaper's dead-worker paths share those events and
			// must not double-free a slot the registry reclaims on its own). The `workerId === msg.workerId`
			// guard above proves the worker reporting this IS the live owner, so its slot is free now.
			this.#d.registry.releaseSlot(msg.workerId);
			this.#d.jobs.requeue(msg.jobId, attempts, this.#d.now());
			this.dispatch();
		} else {
			this.#d.registry.releaseSlot(msg.workerId); // same explicit release, same reason as above
			const updated = this.#d.jobs.fail(msg.jobId, msg.error, this.#d.now(), attempts);
			// Since singing waits on the stems/lyrics gates, a permanently failed process that leaves its
			// gate unsettled makes the song unsingable forever (no way out but a manual DB edit). This same
			// epilogue runs on all three fail paths (this one, the unservable-TTL branch below, and the
			// reaper hook in app.ts) from ONE place, so a fourth fail path can't reopen that hole.
			reportTerminalFailure(updated, 'worker', {
				broadcast: (e) => this.#d.broadcast(e),
				mediaById: this.#d.mediaById,
				persist: (mediaId) => this.#d.persistMedia?.(mediaId)
			});
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

		// Route by the SETTINGS-resolved capability (engine-derived, e.g. stems:roformer), not the bare
		// job type, using the room-capped settings so a lowered process quality routes to a matching worker.
		const settings = this.#processSettings();
		const capabilityFor = (j: { jobType: JobType }) => requiredCapability(j.jobType, settings);

		// Separates "waiting for a free slot" from "no connected worker can EVER run this" — conflating
		// them is how a song sits at 0% forever looking like a hung worker instead of a missing
		// capability. Reported once per job, then again only once the TTL actually fires.
		for (const job of queued) {
			if (hasCapableWorker(job, workers, capabilityFor)) continue;
			const since = this.#unservableSince.get(job.id);
			if (since !== undefined) {
				if (now - since >= UNSERVABLE_TTL_MS) {
					const cap = capabilityFor(job);
					const updated = this.#d.jobs.fail(
						job.id,
						`no connected worker advertised capability '${cap}' within ${Math.round(UNSERVABLE_TTL_MS / 1000)}s`,
						now
					);
					this.#unservableSince.delete(job.id);
					// Same terminal-failure epilogue as #onFailed and the reaper hook: settles the gate (else
					// this job's gate stays mid-flight forever and readyToSing never flips), tells the room,
					// and reclaims scratch.
					reportTerminalFailure(updated, 'unservable', {
						broadcast: (e) => this.#d.broadcast(e),
						mediaById: this.#d.mediaById,
						persist: (mediaId) => this.#d.persistMedia?.(mediaId)
					});
				}
				continue;
			}
			this.#unservableSince.set(job.id, now);
			const cap = capabilityFor(job);
			console.warn(
				`[hub] job ${job.id} (${job.jobType}) needs capability '${cap}' and NO connected worker ` +
					`advertises it — it will stay queued until one does or ${Math.round(UNSERVABLE_TTL_MS / 1000)}s elapse. ` +
					`Connected: ${workers.length === 0 ? 'none' : workers.map((w) => `${w.workerId}[${w.capabilities.join(',')}]`).join(' ')}`
			);
			// Only tell the ROOM when the stall blocks singing: an `align` follow-up on an already-playable
			// song is unservable too, but broadcasting 'queued' for it would regress a ready song back to
			// processing on every phone — missing lyrics is not missing audio.
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
			// Records what was DISPATCHED (the request), not yet the truth — a worker reporting its own
			// resolved model overwrites these via AttemptLedger.reportFacts.
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
				jobId: job.id, // the span id
				processingId: job.processingId, // the trace id across a chained fetch→stems→align run
				mediaId: job.mediaId,
				jobType: job.jobType,
				sourceUri: media ? sourceUriFor(media, this.#d.getSettings?.()?.global.defaultFetcher) : '',
				params
			});
		}
	}

	/** Broadcasts where the SONG is for a job that just changed state — never the job's own status; see
	 *  media-status.ts, which owns that translation. A terminal completion passes through
	 *  `completedStatusFor`, which asks the MEDIA's own gates whether the song is finished. */
	#emitStatus(job: Job, stage?: MediaStatus): void {
		const media = this.#d.mediaById.get(job.mediaId);
		if (!shouldBroadcastProcess(job, media)) return;
		this.#d.broadcast({
			type: 'media:status',
			mediaId: job.mediaId,
			status: job.status === 'ready' ? completedStatusFor(job, media) : mediaStatusFor(job, stage),
			pct: job.progressPct,
			etaSec: job.etaSec ?? undefined
		});
	}
}
