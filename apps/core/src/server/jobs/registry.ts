// Worker registry — IN-MEMORY ONLY, rebuilt from dial-home reconnects, never persisted (§10).
// A worker exists here only while it has a live WS session; on disconnect it's dropped and its
// in-flight jobs are reclaimed by the reaper (M7-C2) via lease expiry. Tracks free slots so the
// dispatcher can pick the least-loaded eligible worker (§4).

import type { JobType } from '@encore/shared';

export interface WorkerSession {
	workerId: string;
	capabilities: JobType[];
	concurrency: number; // max simultaneous jobs this worker accepts
	version: string;
	slotsFree: number; // concurrency minus jobs currently assigned/running to it
	lastSeen: number; // epoch ms of the last hello/heartbeat (liveness)
}

export class WorkerRegistry {
	#workers = new Map<string, WorkerSession>();

	/**
	 * Register or re-register a worker (`worker:hello`). A reconnect with the same workerId REPLACES
	 * the prior session (capabilities/concurrency may have changed); slotsFree resets to concurrency
	 * and the dispatcher will re-assign from the ledger. Returns the session.
	 */
	hello(
		workerId: string,
		capabilities: JobType[],
		concurrency: number,
		version: string,
		now: number
	): WorkerSession {
		const session: WorkerSession = {
			workerId,
			capabilities: [...capabilities],
			concurrency,
			version,
			slotsFree: concurrency,
			lastSeen: now
		};
		this.#workers.set(workerId, session);
		return session;
	}

	/** Liveness + slot reconciliation from a `worker:heartbeat` (the worker is the source of truth
	 *  for what it's actually running). No-op if the worker isn't registered (stale heartbeat). */
	heartbeat(workerId: string, slotsFree: number, now: number): void {
		const w = this.#workers.get(workerId);
		if (!w) return;
		w.slotsFree = Math.max(0, Math.min(slotsFree, w.concurrency));
		w.lastSeen = now;
	}

	get(workerId: string): WorkerSession | null {
		return this.#workers.get(workerId) ?? null;
	}

	/** Drop a worker (WS close). Its jobs are reclaimed by the reaper via lease expiry. */
	remove(workerId: string): void {
		this.#workers.delete(workerId);
	}

	/** Decrement a worker's free slots on dispatch (clamped at 0). */
	claimSlot(workerId: string): void {
		const w = this.#workers.get(workerId);
		if (w) w.slotsFree = Math.max(0, w.slotsFree - 1);
	}

	/** Return a freed slot when a job leaves the worker (complete/fail/cancel/requeue). */
	releaseSlot(workerId: string): void {
		const w = this.#workers.get(workerId);
		if (w) w.slotsFree = Math.min(w.concurrency, w.slotsFree + 1);
	}

	/** All live worker sessions (defensive copies — callers must not mutate registry state). */
	list(): WorkerSession[] {
		return [...this.#workers.values()].map((w) => ({ ...w, capabilities: [...w.capabilities] }));
	}

	get size(): number {
		return this.#workers.size;
	}
}
