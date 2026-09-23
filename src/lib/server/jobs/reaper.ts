// The periodic tick that enforces leases, plus the one-shot boot recovery. I/O orchestrator over the
// pure `sweep`/`inflightToRecover` policy (leases.ts) and the `JobRepository`. See docs/ARCHITECTURE.md §7.

import type { Job } from '../../contract';
import type { JobRepository } from './repository';
import { sweep, inflightToRecover } from './leases';

/** Called after the reaper requeues/fails jobs so the dispatcher can react. */
export type OnReaped = () => void;

/** Fires once per job the reaper moves to terminal `failed`. The reaper has no catalog access, so it
 *  hands the job up for the app to settle that song's readiness gate — skip this and a reaper-killed
 *  process leaves its gate mid-flight forever, holding up rotation. */
export type OnJobFailed = (job: Job) => void;

export interface ReaperOptions {
	/** Reaper cadence; §3 says ~3s. */
	tickMs?: number;
	/** Injected clock for deterministic tests (defaults to Date.now). */
	now?: () => number;
	/** Hook fired once per tick that changed ≥1 job (dispatch trigger). */
	onReaped?: OnReaped;
	/** Hook fired once per job moved to terminal `failed` this tick, so the app can settle its gate. */
	onFailed?: OnJobFailed;
	/** Fires on EVERY tick, changed or not — `onReaped` means "capacity may have changed", `onTick` means
	 *  "time has passed". A purely time-based expiry (e.g. an unservable-job TTL checked only inside the
	 *  event-driven `WorkerHub.dispatch()`) never gets a `sweep()` action to trigger `onReaped`, so folding
	 *  this into `onReaped` would park such a job `queued` forever.
	 *  See tests/unit/server/jobs/terminal-failure-durability.test.ts. */
	onTick?: () => void;
}

export class JobReaper {
	#jobs: JobRepository;
	#tickMs: number;
	#now: () => number;
	#onReaped: OnReaped;
	#onFailed: OnJobFailed;
	#onTick: () => void;
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor(jobs: JobRepository, opts: ReaperOptions = {}) {
		this.#jobs = jobs;
		this.#tickMs = opts.tickMs ?? 3_000;
		this.#now = opts.now ?? Date.now;
		this.#onReaped = opts.onReaped ?? (() => {});
		this.#onFailed = opts.onFailed ?? (() => {});
		this.#onTick = opts.onTick ?? (() => {});
	}

	/** One reaper pass. Returns the number of jobs changed. */
	tick(): number {
		const inflight = this.#jobs.listByStatus('assigned', 'running');
		const now = this.#now();
		const actions = sweep(inflight, now);
		for (const action of actions) {
			if (action.kind === 'requeue') this.#jobs.requeue(action.id, action.attempts, now);
			else this.#onFailed(this.#jobs.fail(action.id, action.error, now, action.attempts));
		}
		if (actions.length > 0) this.#onReaped();
		// onTick fires after onReaped so a tick that changed something has already redispatched first.
		this.#onTick();
		return actions.length;
	}

	/** Resets every in-flight job to queued at startup, before the tick loop runs; attempts are
	 *  preserved since a core restart isn't the worker's fault. Returns the number recovered. */
	recoverOnBoot(): number {
		const inflight = this.#jobs.listByStatus('assigned', 'running');
		const now = this.#now();
		const ids = inflightToRecover(inflight);
		for (const id of ids) this.#jobs.requeue(id, this.#jobByIdAttempts(inflight, id), now, 'RECOVER');
		if (ids.length > 0) this.#onReaped();
		return ids.length;
	}

	/** Start the periodic reaper. Idempotent. */
	start(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => this.tick(), this.#tickMs);
		(this.#timer as { unref?: () => void }).unref?.();
	}

	/** Stop the periodic reaper (graceful shutdown / tests). */
	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	#jobByIdAttempts(inflight: { id: string; attempts: number }[], id: string): number {
		return inflight.find((j) => j.id === id)?.attempts ?? 0;
	}
}
