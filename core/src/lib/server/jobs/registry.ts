// In-memory only, rebuilt from worker reconnects, never persisted. A dropped worker's in-flight
// jobs are reclaimed by the reaper via lease expiry, not by anything in this file.

import type { WorkerHost } from '../../contract';

export interface WorkerSession {
	workerId: string;
	capabilities: string[]; // capability tokens (superset of JobType, e.g. 'stems:roformer')
	concurrency: number; // max simultaneous jobs this worker accepts
	version: string;
	slotsFree: number; // concurrency minus jobs currently assigned/running to it
	lastSeen: number; // epoch ms of the last hello/heartbeat (liveness)
	/** Host info reported at handshake; optional since older workers send none. Lets a reader tell a slow GPU stems run from a shared-core one. */
	host?: WorkerHost;
}

export class WorkerRegistry {
	#workers = new Map<string, WorkerSession>();

	/** Re-registering an existing workerId REPLACES the session: slotsFree resets to concurrency and the dispatcher re-assigns from the ledger, so a reconnect never keeps a stale slot count. */
	hello(
		workerId: string,
		capabilities: string[],
		concurrency: number,
		version: string,
		now: number,
		host?: WorkerHost
	): WorkerSession {
		const session: WorkerSession = {
			workerId,
			capabilities: [...capabilities],
			concurrency,
			version,
			slotsFree: concurrency,
			lastSeen: now,
			...(host ? { host } : {})
		};
		this.#workers.set(workerId, session);
		return session;
	}

	/** The worker is the source of truth for slotsFree; no-op if it isn't registered (stale heartbeat). */
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

	claimSlot(workerId: string): void {
		const w = this.#workers.get(workerId);
		if (w) w.slotsFree = Math.max(0, w.slotsFree - 1);
	}

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
