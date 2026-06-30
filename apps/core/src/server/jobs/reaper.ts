// Job reaper — the single periodic tick (~3s) that enforces leases, plus the one-shot boot
// recovery. I/O orchestrator over the pure `sweep`/`inflightToRecover` policy (leases.ts) and the
// `JobRepository`. A requeue here makes the job eligible for redispatch (M7-C3). See
// docs/job-lifecycle-and-worker-protocol.md §3.

import type { JobRepository } from './repository';
import { sweep, inflightToRecover, DEFAULT_LEASE_CONFIG, type LeaseConfig } from './leases';

/** Called after the reaper requeues/fails jobs so the dispatcher (M7-C3) can react. */
export type OnReaped = () => void;

export interface ReaperOptions {
	config?: LeaseConfig;
	/** Reaper cadence; §3 says ~3s. */
	tickMs?: number;
	/** Injected clock for deterministic tests (defaults to Date.now). */
	now?: () => number;
	/** Hook fired once per tick that changed ≥1 job (dispatch trigger). */
	onReaped?: OnReaped;
}

export class JobReaper {
	#jobs: JobRepository;
	#config: LeaseConfig;
	#tickMs: number;
	#now: () => number;
	#onReaped: OnReaped;
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor(jobs: JobRepository, opts: ReaperOptions = {}) {
		this.#jobs = jobs;
		this.#config = opts.config ?? DEFAULT_LEASE_CONFIG;
		this.#tickMs = opts.tickMs ?? 3_000;
		this.#now = opts.now ?? Date.now;
		this.#onReaped = opts.onReaped ?? (() => {});
	}

	/**
	 * One reaper pass: requeue ack-timed-out jobs (no attempt burned), and for dead running jobs
	 * bump attempts → requeue or fail when exhausted. Returns the number of jobs changed.
	 */
	tick(): number {
		const inflight = this.#jobs.listByStatus('assigned', 'running');
		const now = this.#now();
		const actions = sweep(inflight, now);
		for (const action of actions) {
			if (action.kind === 'requeue') this.#jobs.requeue(action.id, action.attempts, now);
			else this.#jobs.fail(action.id, action.error, now, action.attempts);
		}
		if (actions.length > 0) this.#onReaped();
		return actions.length;
	}

	/**
	 * Boot recovery (§3): reset every in-flight (assigned/running) job to queued — their owning WS
	 * sessions are gone after a core restart. Attempts are preserved (not the worker's fault).
	 * Returns the number recovered. Run once at startup, before the tick loop.
	 */
	recoverOnBoot(): number {
		const inflight = this.#jobs.listByStatus('assigned', 'running');
		const now = this.#now();
		const ids = inflightToRecover(inflight);
		for (const id of ids) this.#jobs.requeue(id, this.#jobByIdAttempts(inflight, id), now);
		if (ids.length > 0) this.#onReaped();
		return ids.length;
	}

	/** Start the periodic reaper. Idempotent. */
	start(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => this.tick(), this.#tickMs);
		// don't keep the process alive solely for the reaper (Bun/Node)
		(this.#timer as { unref?: () => void }).unref?.();
	}

	/** Stop the periodic reaper (graceful shutdown / tests). */
	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	/** Preserve a recovered job's attempts (boot recovery doesn't burn one). */
	#jobByIdAttempts(inflight: { id: string; attempts: number }[], id: string): number {
		return inflight.find((j) => j.id === id)?.attempts ?? 0;
	}
}
