// Pure job state-machine — no DB, no clock, no IO; the I/O wrapper is repository.ts. Single authority
// on which status changes are legal and what causes them. State diagram: docs/ARCHITECTURE.md §7.
// Keyed on the EVENT, not the (from,to) status pair, because a pair is lossy — e.g. `assigned → queued`
// is both a worker REJECT and an ack-timeout LEASE_EXPIRED — and the event is what lets the attempt
// ledger hook the machine itself instead of a hand-written wrapper per call site.

import { isTerminalJob, type JobStatus, type JobEvent } from '../../contract';

/** Legal edges keyed by (from-status, event) → to-status. Terminal states have no outgoing events. */
export const JOB_TRANSITIONS: Record<JobStatus, Partial<Record<JobEvent, JobStatus>>> = {
	queued: {
		DISPATCH: 'assigned',
		CANCEL: 'canceled',
		FAIL: 'failed', // attempts exhausted
		REPRIORITIZE: 'queued' // scheduling-only self-loop (no lifecycle change)
	},
	assigned: {
		ACCEPT: 'running',
		REJECT: 'queued', // worker declined (no attempt burned)
		LEASE_EXPIRED: 'queued', // ack-timeout
		RECOVER: 'queued', // boot recovery of an assigned-but-not-yet-accepted attempt
		CANCEL: 'canceled',
		REPRIORITIZE: 'assigned' // scheduling-only self-loop — an assigned process can still be pulled forward
	},
	running: {
		PROGRESS: 'running', // heartbeat / stage update — the named self-loop
		COMPLETE: 'ready',
		FAIL: 'failed',
		LEASE_EXPIRED: 'queued', // progress-lease expiry
		RECOVER: 'queued', // boot recovery of an interrupted attempt
		CANCEL: 'canceled',
		REPRIORITIZE: 'running' // scheduling-only self-loop (no lifecycle change)
	},
	ready: {},
	failed: {},
	canceled: {}
};

/** The status a job lands in when `event` fires from `from`, or `undefined` if that event is illegal there. */
export function nextStatus(from: JobStatus, event: JobEvent): JobStatus | undefined {
	return JOB_TRANSITIONS[from][event];
}

/** True iff `event` is a legal edge out of `from`. */
export function canFire(from: JobStatus, event: JobEvent): boolean {
	return nextStatus(from, event) !== undefined;
}

/** Throw with a precise message if `event` is illegal from `from`; otherwise return the destination status. */
export function assertEvent(from: JobStatus, event: JobEvent): JobStatus {
	const to = nextStatus(from, event);
	if (to === undefined) {
		const reason = isTerminalJob(from) ? `${from} is terminal` : `no event ${event} from ${from}`;
		throw new Error(`illegal job transition: ${reason}`);
	}
	return to;
}

// Derived status-pair view, kept for callers that only ask "is some edge from A to B legal" — it
// cannot say WHICH event produced the edge, which is why the table above is keyed on the event instead.

/** True iff SOME event carries `from` to `to`. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
	return Object.values(JOB_TRANSITIONS[from]).includes(to);
}

/** Throw with a precise message if no event carries `from` to `to`; otherwise no-op. */
export function assertTransition(from: JobStatus, to: JobStatus): void {
	if (!canTransition(from, to)) {
		const reason = isTerminalJob(from) ? `${from} is terminal` : `no edge ${from} → ${to}`;
		throw new Error(`illegal job transition: ${reason}`);
	}
}
