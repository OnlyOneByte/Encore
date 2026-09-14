// Job reaper — the single periodic tick (~3s) that enforces leases, plus the one-shot boot
// recovery. I/O orchestrator over the pure `sweep`/`inflightToRecover` policy (leases.ts) and the
// `JobRepository`. A requeue here makes the job eligible for redispatch. See
// docs/ARCHITECTURE.md.

import type { Job } from '../../contract';
import type { JobRepository } from './repository';
import { sweep, inflightToRecover } from './leases';

/** Called after the reaper requeues/fails jobs so the dispatcher can react. */
export type OnReaped = () => void;

/**
 * Called once per job the reaper moves to terminal `failed` (attempts exhausted — the worker box
 * died mid-process and never reported). Lets the app settle that song's readiness gate, exactly as the
 * worker-reported and TTL fail paths do; without it a reaper-killed process leaves its gate mid-flight
 * forever and rotation holds the queue entry. The reaper itself has no catalog access,
 * so it hands the failed job up and the app supplies the gate-settling.
 */
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
	/**
	 * Hook fired on EVERY tick, whether or not anything changed. This is what makes the reaper the
	 * system's clock rather than only its change notifier.
	 *
	 * WHY BOTH THIS AND `onReaped`. They answer different questions and collapsing them loses one.
	 * `onReaped` means "capacity may have changed, redispatch now"; `onTick` means "time has passed".
	 * Time-based sweeps need the second, and an unservable job proved it: the unservable-TTL stamp and its
	 * expiry check both live inside `WorkerHub.dispatch()`, which is event-driven, and an unservable job is
	 * never assigned or running. So `sweep()` returned no actions on every tick, `onReaped` never fired,
	 * `dispatch()` was never called again, and the 120s TTL was never reached — the job parked queued
	 * forever, which is the exact hang the TTL was introduced to end.
	 *
	 * The bug survived because the coverage asserting the TTL calls `dispatch()` ITSELF, supplying the
	 * second pass production may never make. A test can be green about a path the running system cannot
	 * reach; `tests/unit/server/jobs/terminal-failure-durability.test.ts` drives the TTL through this
	 * hook instead, so removing it reds.
	 */
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
			else this.#onFailed(this.#jobs.fail(action.id, action.error, now, action.attempts));
		}
		if (actions.length > 0) this.#onReaped();
		// …and ALWAYS, because time passed even when nothing changed. Ordered after `onReaped` so a tick
		// that did change something has already redispatched before the periodic pass runs; the periodic
		// pass is then a no-op for capacity and does the time-based work (the unservable TTL) that no
		// change-gated hook could ever reach.
		this.#onTick();
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
		for (const id of ids) this.#jobs.requeue(id, this.#jobByIdAttempts(inflight, id), now, 'RECOVER'); // boot recovery — the event RECOVER was added for
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
